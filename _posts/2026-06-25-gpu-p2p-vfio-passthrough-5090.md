---
title: "Working GPU P2P inside a VFIO passthrough VM — dual RTX 5090, 56.5 GB/s, no bare metal, no ATS"
date: 2026-06-25 19:00:00 +0800
categories: [ML Systems, GPU Infrastructure]
tags: [gpu, vfio, p2p, rtx5090, proxmox, nccl, deepspeed]
---

> 🌏 中文版：[在 VFIO 直通虚拟机里跑通 GPU P2P —— 双 RTX 5090，56.5 GB/s，非裸机，无 ATS](/posts/gpu-p2p-vfio-passthrough-5090-zh/)
{: .prompt-info }

## TL;DR

I got **GPU-to-GPU peer-to-peer (P2P) DMA working between two RTX 5090s that are both PCIe-passed-through into a single guest VM**. Not on bare metal. Inside a Proxmox/QEMU VFIO passthrough guest.

The numbers, all measured:

- `nvidia-smi topo -p2p r/w`: **NS → OK** (both directions)
- `torch.cuda.can_device_access_peer(0, 1)` and `(1, 0)`: **True**
- **Bandwidth: 56.5 / 56.4 GB/s bidirectional** — a healthy PCIe 5.0 P2P link, matching the ~55 GB/s the community sees on bare metal
- **Data correctness: verified.** 1 GB round-trip transfers with `arange` / `ones` / `randn` patterns, both directions, checksum-compared. No silent corruption. (This matters: the whole worry with P2P-under-IOMMU-translation is that addresses translate *almost* right and you write to the wrong place silently. It didn't happen.)

This goes against the prevailing wisdom. Everything I read — the consumer-P2P patch authors, the bare-metal homelab writeups, the old vfio-users threads, even an NVIDIA forum thread with two 3090s — says GPU P2P either needs bare metal, or needs datacenter cards with ATS, or "just doesn't work in a guest." I'm going to explain why the consensus exists, why it's wrong for this specific case, and give a complete reproducible recipe.

One honest caveat up front, stated loudly because it's the whole point of this post: **I did not invent the P2P unlock.** The kernel-module patch that lifts NVIDIA's software lock on GeForce P2P is aikitoria's work, building on tinygrad's. The bare-metal recipe is well-trodden (smcleod and others). **My only increment is making the exact same thing work inside a VFIO passthrough VM** — which is the part everyone, including me a week earlier, believed was impossible. That's the contribution. Nothing more, and I'd rather be precise than impressive.

## 0. The hardware (so you can reproduce it)

Concrete specs, because "it works on my box" is useless without the box. None of this is secret — it's a published-parts homelab/ML-systems build, and the whole point of writing it up is reproducibility.

| Component | Spec |
|---|---|
| **Motherboard** | Gigabyte **MZ73-LM2** (dual-socket SP5) |
| **CPU** | AMD **EPYC 9755** — 128 cores, **12-channel DDR5** |
| **RAM** | **1 TB DDR5** (the box is RAM-heavy on purpose; see §5) |
| **GPUs** | **2× NVIDIA RTX 5090, 32 GB each** (GB202, consumer die — **no NVLink, no ATS**) |
| **GPU slots** | dual **PCIe 5.0 x16** |
| **Hypervisor** | Proxmox VE 9.0.11, guest is a `q35` QEMU VM (passthrough) |
| **Guest OS** | Ubuntu 24.04, kernel 6.8 |
| **CUDA stack** | CUDA 13 userspace, driver `580.95.05` (patched — see §3) |

A few things to flag, because they explain later sections:

- **GB202 is a consumer die.** No NVLink fabric, no ATS capability (I checked `lspci -vvv` — see §1). So both datacenter routes to VM P2P are physically absent on this silicon.
- The two cards sit under the CPU root complex with a **PHB topology** (same socket, different root ports — no PCIe switch between them). That's a real PCIe 5.0 x16 path, not a bifurcated x8/x8.
- **12-channel DDR5 + 1 TB** is not for P2P — it's for the CPU-offload fine-tuning in §5, where parameters and optimizer state live in host RAM. The big-RAM EPYC shape is the whole reason that workload fits.

## 1. Why everyone thinks this can't work in a VM

If you go looking, the consensus is remarkably uniform.

- **The consumer P2P patch's own README requires `iommu=pt`** — i.e. the IOMMU set to passthrough so it does *not* translate addresses. The patch works by writing the peer GPU's physical BAR address straight into the source GPU's page tables and trusting that "the physical address is the physical address." That's bare-metal logic. The moment you hear "VFIO," your reflex is: VFIO's entire job is to make the IOMMU translate guest addresses for isolation. "Don't translate" (what the patch wants) and "must translate" (what passthrough is) look like a head-on collision.
- **Every bare-metal homelab writeup is exactly that — bare metal.** The dual/quad/oct-5090 P2P success stories all run the patch on the host, no virtualization in the path.
- **Old vfio-users folklore**: "guest GPU P2P doesn't work," full stop.
- **The one direct datapoint I could find** — an NVIDIA developer-forum thread with two 3090s passed into a guest — reports `topo -p2p` showing **NS in every cell**, and no resolution. (That all-`NS` state is exactly the "before" half of **Figure 1** in §4; the "after" half is what this post is about.)

And there's a deeper, more credible version of the argument that isn't just folklore. Datacenter cards (A100/H100/L40S) *do* P2P inside VMs, and they do it via **ATS** (Address Translation Services): the device pre-translates guest-physical to host-physical, caches it in its own DevTLB, and issues "already-translated" requests that ride through the IOMMU with ACS DirectTranslated. That's the blessed path, and it's why people say "VM P2P needs ATS."

So I checked. `lspci -vvv` on each 5090's capability list: **PM, MSI, Express, Vendor-Specific, MSI-X — and no ATS capability at all.** GB202 is a consumer die; ATS isn't there. NVLink isn't there either (GB202 has no NVLink fabric). So both datacenter paths to VM P2P — NVLink and ATS — are physically absent on this card. That's a real, on-silicon reason to expect failure, and it's why I spent a while convinced the only reliable 5090 P2P was bare metal.

I was wrong, and the reason I was wrong is interesting.

## 2. The mechanism (the part of this post actually worth reading)

The error in the "it can't work" argument is a direction error. People (me included) assumed the patch needs to *bypass* IOMMU translation, and that VFIO can't allow a bypass. The truth is the opposite: **VFIO makes P2P work by translating, and that's exactly what you want.**

Here's the chain, as best I can reconstruct it from the VFIO maintainer's own list posts plus the patch source:

1. **VFIO (the classic type1 backend) already maps peer BARs into the IOMMU domain.** When you pass two GPUs into the same guest, VFIO maps GPU-B's BAR as a guest-physical → host-physical entry inside GPU-A's IOMMU domain. So when GPU-A emits a DMA to "GPU-B's BAR at *this guest-physical address*," the host IOMMU translates it to the real host-physical address and the transaction lands on GPU-B. The VFIO maintainer (Alex Williamson) describes this peer-BAR mapping as having "essentially always been present." **This does not need ATS** — ATS is the device pre-translating for itself; here the IOMMU just does the translation on the device's behalf, the ordinary way.

2. **Why the patch's `iommu=pt` requirement isn't a contradiction here.** On bare metal, the patch hard-writes the peer's *physical* BAR address into the GPU page tables and never calls `dma_map_resource`. With `iommu=pt`, the host doesn't re-translate, so the physical address it wrote is the physical address that gets used — correct on bare metal. Move that same code into a guest **with no vIOMMU**, and the "physical address" the driver writes is actually GPU-B's BAR *guest-physical* address. As long as VFIO has mapped that guest-physical into the domain — which, per point 1, it has — the host IOMMU translates that GPA to the right host-physical. The driver thinks it's doing bare-metal physical writes; VFIO silently makes them correct. The two layers compose instead of colliding.

3. **So the IOMMU was never turned off — it just moved down a layer.** Inside the guest there's no vIOMMU, so from the driver's point of view nothing is translating (which is what the patch needs). On the host, the IOMMU is very much on and translating every peer-BAR access (which is what passthrough needs). The translation that the consensus assumed had to be disabled is still happening — it's just on the host side, invisible to the guest driver.

That's the whole trick. **No ATS, no NVLink, no bare metal.** Just: let VFIO's native peer-BAR translation carry the addresses, and use the patch *only* to lift NVIDIA's software P2P lock — not to manage addresses.

The thing I'd been missing, and the thing the pessimistic "needs ATS" conclusion missed, is that ATS is an *optimization* for letting the device skip the IOMMU, not a *requirement* for P2P-under-IOMMU. The plain IOMMU translation path was there the whole time. It just needed two preconditions satisfied that nobody had lined up together inside a guest: a big enough BAR to map, and the driver software lock lifted.

## 3. The complete reproducible recipe

This is the full chain. **Every item is load-bearing; drop one and `topo -p2p` goes back to NS.** I'll flag the two that bit me hardest. Below the prose I've put copy-pasteable config blocks for the exact values on this box.

1. **VM machine type `q35`.** Not `i440FX`. The ancient i440FX chipset won't give you a sane PCIe topology or large MMIO windows. (Switching chipset is also where you discover your guest NIC gets renamed and your network config breaks — match interfaces by MAC in netplan, not by name, or you'll lock yourself out. Unrelated to P2P, but it'll eat your afternoon.)

2. **Both GPUs passed through with `pcie=1`** (Proxmox `hostpciN: ...,pcie=1`). They need to present as PCIe devices, not legacy PCI, in the guest.

3. **VFIO `type1` backend — *not* IOMMUFD.** This is the silent killer. The newer IOMMUFD backend **does not yet map hardware PCI BAR regions**, which is exactly the mapping P2P depends on (QEMU's own docs say PCI P2P DMA is unsupported under IOMMUFD for this reason). Proxmox defaults to type1; just don't go enabling IOMMUFD. If you've flipped it on, flip it back.

4. **No vIOMMU in the guest** (the default — keep it that way). This is what lets the patched driver's "physical address" writes actually be guest-physical addresses that VFIO has mapped (see §2). Add a vIOMMU and you reintroduce a translation layer the driver isn't accounting for.

5. **Host kernel `iommu=pt`** (with `amd_iommu=on` on this AMD host). Passthrough mode on the host side.

6. **BIOS: "Prefetchable MMIO Above 4G Size" ≥ 32G.** This is the one nearly everyone misses. Out of the box the upstream bridge MMIO window is tiny (~577 MB) and the GPU's **BAR1 only gets 256 MB**. P2P over BAR1 needs the *whole* framebuffer aperture exposed, so BAR1 has to be sized up to 32G — which means the bridge window above 4G has to be ≥ 32G. On the MZ73-LM2 this lived under `Advanced → PCI Subsystem Settings → Prefetchable MMIO Above 4G Size`; setting it to 64G let the upstream bridge window grow 577M → 33089M and BAR1 grow 256M → 32G. **You cannot do this from the OS.** `pci=realloc` doesn't help, runtime sysfs `resourceN_resize` returns ENOTSUPP — it has to come from BIOS, because the bridge window is fixed at firmware enumeration. If `topo -p2p` says OK but bandwidth is garbage or it still says NS, check `lspci -vvv` for BAR1 size first.

7. **The consumer P2P patch driver, version-matched to your userspace.** I used aikitoria's `open-gpu-kernel-modules` at the `580.95.05-p2p` tag because my installed userspace/CUDA stack was 580.95.05. **Match the version exactly** — you're only swapping the kernel module; CUDA, the userspace libraries, and PyTorch stay untouched. That's the lowest-risk way to do it: if the patched module misbehaves you `rmmod`/restore the stock module and you're back, no CUDA reinstall. Keep a backup of the stock modules and you have a one-command rollback.

### Config blocks (the exact values on this box)

**(a) Proxmox VM config** — `q35` machine + both GPUs as PCIe (`/etc/pve/qemu-server/<vmid>.conf`, abridged to the P2P-relevant lines):

```ini
machine: q35
cpu: host
# both 5090s, passed through as PCIe (not legacy PCI):
hostpci0: <gpu0-pci-addr>,pcie=1
hostpci1: <gpu1-pci-addr>,pcie=1
# (no vIOMMU line — do NOT add viommu=...; keep the guest without a virtual IOMMU)
```

> Equivalent `qm` commands:
>
> ```bash
> qm set <vmid> --machine q35
> qm set <vmid> --cpu host
> qm set <vmid> --hostpci0 <gpu0-pci-addr>,pcie=1
> qm set <vmid> --hostpci1 <gpu1-pci-addr>,pcie=1
> ```
>
> Replace `<gpu0-pci-addr>` / `<gpu1-pci-addr>` with each card's host PCI address (`lspci -nn | grep -i nvidia`).

![Proxmox qm config: machine = q35 with both GPUs passed through as hostpci0/hostpci1, pcie=1](/assets/img/p2p-vfio/05-qm-config-q35-pcie.png)
_**Figure 5.** The live `qm config` for this VM (only the P2P-relevant lines shown): `machine: q35`, `cpu: host`, and both 5090s passed through as `hostpci0: ...,pcie=1` / `hostpci1: ...,pcie=1`. This is recipe items 1–2 in effect — `q35` chipset plus `pcie=1` make the cards present as real PCIe devices in the guest._

**(b) Host kernel cmdline** — IOMMU in passthrough mode (AMD host). Edit `GRUB_CMDLINE_LINUX_DEFAULT` in `/etc/default/grub`, then `update-grub` and reboot:

```bash
# /etc/default/grub
GRUB_CMDLINE_LINUX_DEFAULT="quiet amd_iommu=on iommu=pt"
```

> `amd_iommu=on` turns the IOMMU on; `iommu=pt` puts it in passthrough so the host doesn't re-translate (the patch's bare-metal precondition). On an Intel host the equivalent is `intel_iommu=on iommu=pt`.

![host /proc/cmdline showing amd_iommu=on iommu=pt (PCI passthrough mode)](/assets/img/p2p-vfio/06-host-cmdline-iommu-pt.png)
_**Figure 6.** The live host `/proc/cmdline`, confirming `amd_iommu=on iommu=pt` are actually in effect on the running kernel (alongside `pci=realloc`). This is recipe item 5 — the IOMMU is on but in passthrough mode, the precondition the patch's bare-metal logic relies on._

**(c) Make sure VFIO uses the type1 backend, NOT IOMMUFD.** Proxmox defaults to type1, so usually this is "do nothing." The point is to *not* enable IOMMUFD:

```bash
# Sanity-check that the legacy/type1 container is in use (this is the default).
# If you ever see iommufd referenced in the QEMU args for the VM, you've switched
# backends — revert it. QEMU docs: PCI P2P DMA is unsupported under IOMMUFD because
# it does not map hardware PCI BAR regions yet.
qm showcmd <vmid> | tr ' ' '\n' | grep -iE 'iommufd|vfio'
# Expect vfio-pci device entries WITHOUT an iommufd backend object.
```

**(d) BIOS settings (MZ73-LM2)** — these are firmware toggles, set them in setup and reboot:

```text
Advanced → PCI Subsystem Settings →
    Prefetchable MMIO Above 4G Size = 64G   # the critical one: bridge window 577M → 33089M, BAR1 256M → 32G
    Re-Size BAR Support             = Enabled
    Above 4G Decoding               = Enabled
AMD CBS → NBIO Common Options →
    PCIe ARI Support                = Enabled
Boot →
    CSM (Compatibility Support Module) = Disabled
```

> Verify after reboot, on the host *and* in the guest:
>
> ```bash
> # BAR1 should read 32G, not 256M:
> lspci -vvv -s <gpu-pci-addr> | grep -i 'Region 1'
> ```

![BAR1 sized to 32G: lspci shows Region 1 size=32G and Resizable BAR current size 32GB](/assets/img/p2p-vfio/04-bar1-32g.png)
_**Figure 4.** Proof the BIOS "above-4G prefetchable MMIO" window did its job: `lspci -vvv` reports `Region 1: ... [size=32G]` and the Physical Resizable BAR capability shows `BAR 1: current size: 32GB, supported: 32GB`. Out of the box BAR1 is only 256 MB; this 32G aperture is what P2P-over-BAR1 DMAs into. This is the single most-skipped step in the whole recipe._

### Why type1 and not IOMMUFD, restated

Because P2P needs the peer BAR mapped into the IOMMU domain, and **IOMMUFD doesn't map BARs yet**. type1 does (and "essentially always has"). This is the single most counterintuitive line in the recipe — the *newer* backend is the one that breaks P2P — so it's worth saying twice.

### Why BAR1 has to be maxed, restated

P2P traffic goes through GPU-B's BAR1 (its framebuffer aperture). If BAR1 is the default 256 MB, there's no aperture to DMA into and you get NS or a crippled link regardless of everything else being right. The 32G BAR1 is gated entirely on the BIOS "above-4G prefetchable MMIO" window, and that window can only be set in BIOS. If I had to name the single most-skipped step in this whole recipe, it's this one.

## 4. The evidence

```text
$ nvidia-smi topo -p2p r
        GPU0    GPU1
 GPU0   X       OK
 GPU1   OK      X
```

(Before the recipe: every off-diagonal cell read `NS`.)

![nvidia-smi topo -p2p before vs after: stock driver NS → patched OK (read and write, both directions)](/assets/img/p2p-vfio/01-p2p-topo.png)
_**Figure 1.** `nvidia-smi topo -p2p r/w` inside the guest. With the stock NVIDIA driver every off-diagonal cell reads `NS` (Not Supported — the consumer driver's software lock on GeForce P2P); after the aikitoria-patched `580.95.05` module, every cell reads `OK` for both reads and writes, both directions. This is the headline result: P2P enabled inside a VFIO passthrough VM._

```python
>>> import torch
>>> torch.cuda.can_device_access_peer(0, 1), torch.cuda.can_device_access_peer(1, 0)
(True, True)
```

Bandwidth (`p2pBandwidthLatencyTest`-class measurement): **56.5 GB/s** one direction, **56.4 GB/s** the other. That's a clean PCIe 5.0 x16 P2P link.

![measured P2P bandwidth: 56.5 GB/s in both directions over PCIe Gen5 x16](/assets/img/p2p-vfio/02-p2p-bandwidth.png)
_**Figure 2.** A torch GPU→GPU copy benchmark (0.75 GiB buffer per direction), with `can_device_access_peer` returning `True` both ways. Measured **56.5 GB/s** GPU0→GPU1 and **56.5 GB/s** GPU1→GPU0 — a clean, symmetric PCIe 5.0 x16 P2P link, matching the ~55 GB/s the community sees on bare metal._

Correctness — the part I cared about most, because IOMMU-translated P2P that's *almost* right is worse than no P2P at all:

- `arange`, `ones`, and `randn` tensors, **1 GB each**, copied GPU→GPU and back, both directions
- every round trip checksum-compared against the source
- **all passed.** No silent address mistranslation, no corruption.

![P2P round-trip data correctness: arange / ones / randn tensors all verify torch.equal = True, ALL_PASS](/assets/img/p2p-vfio/03-p2p-data-correctness.png)
_**Figure 3.** Data-correctness check: each of `arange`, `ones`, and `randn` tensors is copied GPU0→GPU1→GPU0 (round trip) and compared to the original with `torch.equal`. All three return `True` (`DATA_CORRECTNESS_ALL_PASS=True`). This is the test that matters most — it proves the IOMMU-translated P2P path is not silently writing to the wrong address._

I also restarted a real CUDA workload (an in-house TTS/voice service) on the patched driver and confirmed it loads and serves normally — i.e. the patched kernel module is safe for everyday CUDA work, not just for the P2P test. And the whole config survives a guest reboot: BIOS window, GRUB `iommu=pt`, `pcie=1`, and the patched module all persist.

## 5. Appendix — the thing I actually wanted the box for: 32B full-parameter fine-tuning

P2P is a fun result, but to be honest it's tangential to my real workload. I wanted to know whether I could **full-parameter fine-tune a 32B model** on this box at all. Spoiler: yes — and notably, *this part doesn't use P2P*. ZeRO-style CPU offload moves tensors GPU↔CPU-RAM, not GPU↔GPU, so the fine-tune below ran on plain NCCL and would run fine with P2P disabled. I'm including it because it's the same box, same session, and it's a useful "is the hardware actually enough?" datapoint.

**Setup:** a ~32B dense model, **bf16**, **DeepSpeed ZeRO-3 with parameters *and* optimizer state fully offloaded to CPU**, across both 5090s. Full-parameter, not LoRA. (Note: bf16, not int8 — int8 is an inference quantization; full-parameter weight updates need the precision.)

**Measured, 40-step run, steady state excludes the first 5 warmup steps:**

| Metric | Value |
|---|---|
| Model | ~32B params, dense |
| dtype | bf16 |
| Optimizer | AdamW (DeepSpeed cpu_adam, CPU offload), lr 1e-4 |
| Parallelism | DeepSpeed ZeRO-3, 2 GPUs |
| Offload | param → CPU + optimizer → CPU (pinned) |
| Effective batch | 2 (micro-bs 1 × accum 1 × 2 GPUs) |
| Seq len | 512 (1024 tokens/step) |
| **Step time (steady)** | **17.43 s ± 0.16 s** |
| **Throughput** | **58.7 tokens/s** |
| **VRAM peak (this job)** | **~10 GiB / card** |
| **RAM peak** | **~1.14 TiB committed** |

The proof that the optimizer is *actually* updating weights through the offload path: a fixed-batch overfit (same batch every step) drove loss from **11.64 down to ~0.015** — roughly three orders of magnitude, monotonically after the warmup. If the offloaded optimizer weren't really applying updates, loss wouldn't move. It moved.

![32B full-parameter fine-tune: per-step loss table (11.64 → ~0.015), 17.43 s/step steady state, 58.7 tokens/s](/assets/img/p2p-vfio/07-32b-benchmark.png)
_**Figure 7.** A real 40-step run of full-parameter fine-tuning on a ~32B dense model (bf16, DeepSpeed ZeRO-3 with params and optimizer fully offloaded to CPU, across both 5090s). The per-step loss table shows the fixed-batch overfit driving loss from **11.64** down to **~0.015** monotonically, and the summary confirms **17.43 s/step** steady state, **58.7 tokens/s**, ~10 GiB VRAM/card, ~1.14 TiB RAM committed. Note: this workload runs on plain NCCL and does *not* use P2P._

**The honest read:** this is the **offload slow path**. ~17.4 s/step and ~59 tokens/s is not a high-throughput training setup — it's a "can a single box with two consumer cards even *do* 32B full-parameter fine-tuning?" answer, and the answer is yes. The trick that makes it possible is the asymmetry: with parameters and optimizer state living in CPU RAM, the **GPU footprint collapses to ~10 GiB/card** (the GPU only holds the current layer plus activations), while the **cost moves to ~1.14 TiB of RAM** (bf16 params + fp32 Adam m/v state). That's the trade — VRAM-bound becomes RAM-bound — and it's why a big-RAM EPYC box (12-channel DDR5, 1 TB) is the right shape for this even with "only" 32 GB cards.

**Two reproducibility traps worth flagging:**

- **ninja must be on PATH.** DeepSpeed's `cpu_adam` op JIT-compiles on the first step and needs the `ninja` binary findable; if it's installed in a venv bin that isn't on PATH you get `Unable to JIT load the cpu_adam op`. Export the venv bin onto PATH before launch.
- **You must load the model under a ZeRO-3 init context.** Instantiate `HfDeepSpeedConfig(ds_config)` and keep it alive *before* `from_pretrained`, so the 32B model is sharded at construction time. A plain `from_pretrained` will try to put the whole ~64 GB bf16 model on one card and OOM before training even starts.

## 6. Credits and the exact boundary of what's new here

Plainly, so nobody mistakes the contribution:

- **The P2P software unlock is not mine.** It's aikitoria's patched `open-gpu-kernel-modules`, which builds on tinygrad's earlier work on lifting NVIDIA's GeForce P2P lock. If you run consumer-card P2P at all, on bare metal or in a VM, that's the patch doing the heavy lifting.
- **The bare-metal recipe and the BAR-resize knowledge are well-established** in the homelab/ML-systems community (smcleod's writeups among others). I followed their trail.
- **My one increment is the VM part:** demonstrating that the *same* unlock works **inside a VFIO passthrough guest** — with the type1-backend / no-vIOMMU / host-`iommu=pt` / patch-only-for-the-software-lock framing — plus the mechanism explanation for *why* (VFIO's native peer-BAR translation carries it, no ATS needed), and a correctness check that it isn't silently mistranslating.

I want to be careful **not** to oversell this as "unlocking consumer-card P2P" — that was already unlocked by people smarter than me. What was missing was a worked, correctness-checked example of it surviving the trip into a passthrough VM, against a near-unanimous consensus that it couldn't. That gap is now closed, with a recipe. Drawing that line clearly is, I think, what makes the result trustworthy rather than another breathless homelab headline.

If you reproduce this on a different board or driver version, I'd genuinely like to know — especially whether the type1 peer-BAR mapping behaves the same on Intel hosts and whether bandwidth holds when the two cards sit under different root ports.

## References

- **aikitoria**, patched `open-gpu-kernel-modules` (`580.95.05-p2p` tag) — the GeForce P2P software unlock used here.
- **tinygrad** — earlier work lifting NVIDIA's GeForce P2P lock, which the patch builds on.
- **smcleod** and the broader homelab / ML-systems community — bare-metal multi-5090 P2P recipes and the BAR-resize knowledge.
- **Alex Williamson** (VFIO maintainer) — kernel mailing-list posts describing VFIO type1's peer-BAR mapping as "essentially always present."
- **QEMU documentation** — notes that PCI P2P DMA is unsupported under the IOMMUFD backend (it does not yet map hardware PCI BAR regions).

---

> Every claim in this post is backed by a real terminal evidence image, rendered on this machine and desensitized.
{: .prompt-tip }
