---
title: "在 VFIO 直通虚拟机里跑通 GPU P2P —— 双 RTX 5090，56.5 GB/s，非裸机，无 ATS"
date: 2026-06-25 19:00:00 +0800
categories: [ML Systems, GPU Infrastructure]
tags: [gpu, vfio, p2p, rtx5090, proxmox, nccl, deepspeed]
lang: zh-CN
---

> 🌏 English: [Working GPU P2P inside a VFIO passthrough VM — dual RTX 5090, 56.5 GB/s, no bare metal, no ATS](/posts/gpu-p2p-vfio-passthrough-5090/)
{: .prompt-info }

## 摘要

我让 **GPU 到 GPU 的点对点(P2P)DMA 在两张 RTX 5090 之间跑通了，而这两张卡都是经 PCIe 直通到同一个 guest 虚拟机里的**。不是裸机，是在 Proxmox/QEMU 的 VFIO 直通 guest 里。

实测数据:

- `nvidia-smi topo -p2p r/w`:**NS → OK**(双向)
- `torch.cuda.can_device_access_peer(0, 1)` 和 `(1, 0)`:**True**
- **带宽:56.5 / 56.4 GB/s 双向** —— 一条健康的 PCIe 5.0 P2P 链路，与社区在裸机上看到的 ~55 GB/s 对齐
- **数据正确性:已验证。** 用 `arange` / `ones` / `randn` 三种模式各 1 GB 双向往返、逐一 checksum 比对，无静默腐败。(这点很关键:IOMMU 翻译下做 P2P 的最大隐患就是地址翻译得*几乎*对、于是悄悄写到错误位置。没有发生。)

这与主流认知相悖。我读到的所有材料——消费卡 P2P 补丁作者、裸机 homelab 教程、老 vfio-users 邮件列表帖，甚至一个两张 3090 的 NVIDIA 论坛帖——都说 GPU P2P 要么必须裸机、要么必须带 ATS 的数据中心卡、要么"在 guest 里就是不行"。下面我会说明这个共识为什么存在、为什么对这个具体场景是错的，并给出完整可复现配方。

先把一句诚实的话讲在前面，因为它是这篇的全部要点:**P2P 软锁的破解不是我做的。** 解除 NVIDIA 对 GeForce P2P 软件封锁的内核模块补丁是 aikitoria 的工作，建立在 tinygrad 早期工作之上;裸机配方也是社区走熟的路(smcleod 等)。**我唯一的增量是让同样的东西在 VFIO 直通 VM 里跑通**——而这正是所有人(包括一周前的我)都认为不可能的部分。这就是贡献，仅此而已;我宁愿精确，也不要显得唬人。

## 0. 硬件规格(为了让你能复现)

给出具体规格，因为"在我机器上能跑"没有那台机器就毫无意义。这里没有任何机密——它是一台用公开零件搭的 homelab / ML-systems 机器，写出来的全部目的就是可复现。

| 组件 | 规格 |
|---|---|
| **主板** | 技嘉 **MZ73-LM2**(双路 SP5) |
| **CPU** | AMD **EPYC 9755** —— 128 核，**12 通道 DDR5** |
| **内存** | **1 TB DDR5**(这台机器是故意堆大内存的，见 §5) |
| **显卡** | **2× NVIDIA RTX 5090，各 32 GB**(GB202 消费 die —— **无 NVLink、无 ATS**) |
| **显卡插槽** | 双 **PCIe 5.0 x16** |
| **虚拟化** | Proxmox VE 9.0.11，guest 是 `q35` QEMU 直通 VM |
| **Guest 系统** | Ubuntu 24.04，内核 6.8 |
| **CUDA 栈** | CUDA 13 userspace，驱动 `580.95.05`(已打补丁，见 §3) |

几点需要标出，它们解释了后文:

- **GB202 是消费 die。** 没有 NVLink fabric，没有 ATS 能力(我用 `lspci -vvv` 核过——见 §1)。所以数据中心通向 VM-P2P 的两条路在这块硅片上物理缺席。
- 两张卡挂在 CPU root complex 下、拓扑为 **PHB**(同 socket、不同 root port，中间没有 PCIe switch)。这是一条真正的 PCIe 5.0 x16 通路，不是拆分的 x8/x8。
- **12 通道 DDR5 + 1 TB** 不是为 P2P 准备的——是为 §5 的 CPU-offload 微调准备的，那里参数和优化器状态都驻留在 host RAM。大内存 EPYC 的形态正是那个工作负载塞得下的全部原因。

## 1. 为什么大家都认为这在 VM 里跑不通

你去翻资料，会发现共识高度一致。

- **消费卡 P2P 补丁自己的 README 要求 `iommu=pt`** —— 也就是把 IOMMU 设成 passthrough、让它*不*翻译地址。补丁的工作方式是把对端 GPU 的物理 BAR 地址直接写进源 GPU 的页表，然后相信"物理地址就是物理地址"。这是裸机逻辑。一听到"VFIO"，你的本能反应就是:VFIO 的全部职责就是为了隔离而让 IOMMU 翻译 guest 地址。"别翻译"(补丁想要的)和"必须翻译"(直通的本质)看上去是正面冲撞。
- **每一篇裸机 homelab 教程都正是——裸机。** 那些双卡/四卡/八卡 5090 的 P2P 成功故事全在 host 上跑补丁，链路里没有虚拟化。
- **老 vfio-users 民间说法**:"guest 里 GPU P2P 不行"，句号。
- **我能找到的唯一一个直接数据点** —— 一个把两张 3090 直通进 guest 的 NVIDIA 开发者论坛帖——报告 `topo -p2p` 每一格都是 **NS**，且无解。(那个全 `NS` 的状态正是 §4 **图 1** 的"补丁前"那一半;"补丁后"那一半就是这篇要讲的。)

而且还有一个更深、更可信、不只是民间传说的版本。数据中心卡(A100/H100/L40S)*确实*能在 VM 里做 P2P，靠的是 **ATS**(地址翻译服务):设备自己把 guest-physical 预翻译成 host-physical、缓存进自己的 DevTLB、发出"已翻译"的请求，这些请求带 ACS DirectTranslated 穿过 IOMMU。这是官方认证的路，也是"VM P2P 需要 ATS"这句话的由来。

于是我去查。对每张 5090 跑 `lspci -vvv` 看能力列表:**PM、MSI、Express、Vendor-Specific、MSI-X —— 根本没有 ATS 能力。** GB202 是消费 die，没有 ATS;NVLink 也没有(GB202 没有 NVLink fabric)。所以通向 VM-P2P 的两条数据中心路——NVLink 和 ATS——在这张卡上物理缺席。这是一个真实的、刻在硅片上的理由去预期失败，也是我一度确信"唯一可靠的 5090 P2P 是裸机"的原因。

我错了，而错的原因很有意思。

## 2. 机制(这篇真正值得读的部分)

"它不可能跑通"这个论证里的错误是一个方向错误。大家(包括我)都假设补丁需要*绕过* IOMMU 翻译，而 VFIO 不可能允许绕过。真相恰恰相反:**VFIO 是靠翻译来让 P2P 成立的，而这正是你想要的。**

下面这条链，是我尽力从 VFIO 维护者的邮件列表帖加上补丁源码重建出来的:

1. **VFIO(经典的 type1 后端)本来就把 peer BAR 映进 IOMMU 域。** 当你把两张 GPU 直通进同一个 guest，VFIO 会把 GPU-B 的 BAR 作为一条 guest-physical → host-physical 的条目映进 GPU-A 的 IOMMU 域。于是当 GPU-A 向"GPU-B 的 BAR、在*这个 guest-physical 地址*上"发起 DMA 时，host IOMMU 把它翻译成真正的 host-physical 地址，事务落到 GPU-B 上。VFIO 维护者(Alex Williamson)说这条 peer-BAR 映射"基本上一直都在"。**这不需要 ATS**——ATS 是设备替自己预翻译;这里只是 IOMMU 替设备做翻译，普普通通的那种。

2. **为什么补丁要求的 `iommu=pt` 在这里不是矛盾。** 在裸机上，补丁把对端的*物理* BAR 地址硬写进 GPU 页表、从不调 `dma_map_resource`。有 `iommu=pt`，host 不再翻译，所以它写进去的物理地址就是被使用的物理地址——裸机上正确。把同一段代码搬进一个**没有 vIOMMU** 的 guest，驱动写进去的"物理地址"其实是 GPU-B 的 BAR 的 *guest-physical* 地址。只要 VFIO 已把那个 guest-physical 映进了域里——按第 1 点，它确实映了——host IOMMU 就把那个 GPA 翻译到正确的 host-physical。驱动以为自己在做裸机物理写;VFIO 悄悄把它们变成正确的。两层是叠加，不是冲撞。

3. **所以 IOMMU 从没被关掉——它只是下移了一层。** guest 内部没有 vIOMMU，所以从驱动的视角看没有任何东西在翻译(这正是补丁需要的)。在 host 上，IOMMU 非常之开、在翻译每一次 peer-BAR 访问(这正是直通需要的)。共识以为必须被关掉的那层翻译其实仍在发生——只是在 host 侧、对 guest 驱动不可见。

这就是全部把戏。**无 ATS、无 NVLink、非裸机。** 只是:让 VFIO 原生的 peer-BAR 翻译来扛地址，把补丁*只*用来解除 NVIDIA 的软件 P2P 锁——不用它来管地址。

我此前漏掉的、悲观的"需要 ATS"结论也漏掉的一点是:ATS 是让设备跳过 IOMMU 的一个*优化*，不是 IOMMU 翻译下做 P2P 的*必要条件*。朴素的 IOMMU 翻译路径一直都在。它只需要两个前提在 guest 里被同时凑齐:一个够大、能被映射的 BAR，以及被解除的驱动软件锁。

## 3. 完整可复现配方

这是完整的链。**每一项都承重;漏掉任何一项，`topo -p2p` 就回到 NS。** 我会标出咬我最狠的两项。文字下面是可直接复制粘贴的配置块，数值就是这台机器上的真实值。

1. **VM 机型用 `q35`。** 不是 `i440FX`。古董 i440FX 芯片组给不了正常的 PCIe 拓扑或大 MMIO 窗口。(换芯片组也是你会发现 guest 网卡被改名、网络配置崩掉的地方——netplan 里按 MAC 匹配接口、别按名字，否则会把自己锁在外面。与 P2P 无关，但会吃掉你一下午。)

2. **两张 GPU 都用 `pcie=1` 直通**(Proxmox `hostpciN: ...,pcie=1`)。它们要在 guest 里以 PCIe 设备、而非 legacy PCI 出现。

3. **VFIO 用 `type1` 后端——*不是* IOMMUFD。** 这是沉默的杀手。较新的 IOMMUFD 后端**目前还不映射硬件 PCI BAR 区域**，而那正是 P2P 依赖的映射(QEMU 自己的文档就因此说 IOMMUFD 下不支持 PCI P2P DMA)。Proxmox 默认就是 type1;别去开 IOMMUFD。如果你开过，关回去。

4. **guest 里不加 vIOMMU**(默认如此——保持原样)。这正是让打了补丁的驱动写的"物理地址"实际上成为 VFIO 已映射的 guest-physical 地址的关键(见 §2)。加了 vIOMMU，你就重新引入了一层驱动没有计入的翻译。

5. **host 内核 `iommu=pt`**(这台 AMD host 上配 `amd_iommu=on`)。host 侧的 passthrough 模式。

6. **BIOS:"Prefetchable MMIO Above 4G Size" ≥ 32G。** 这是几乎所有人都漏的一项。开箱状态下上游桥 MMIO 窗口很小(~577 MB)，GPU 的 **BAR1 只拿到 256 MB**。BAR1 上的 P2P 需要*整个* framebuffer aperture 被暴露，所以 BAR1 必须撑到 32G——这意味着 4G 以上的桥窗口必须 ≥ 32G。在 MZ73-LM2 上这一项在 `Advanced → PCI Subsystem Settings → Prefetchable MMIO Above 4G Size`;设成 64G 后，上游桥窗口从 577M 长到 33089M、BAR1 从 256M 长到 32G。**这件事不能从操作系统做。** `pci=realloc` 没用，运行时 sysfs `resourceN_resize` 返回 ENOTSUPP——它必须来自 BIOS，因为桥窗口在固件枚举期就被定死了。如果 `topo -p2p` 显示 OK 但带宽很烂、或仍显示 NS，先用 `lspci -vvv` 查 BAR1 大小。

7. **消费卡 P2P 补丁驱动，与你的 userspace 版本精确匹配。** 我用了 aikitoria 的 `open-gpu-kernel-modules` 的 `580.95.05-p2p` tag，因为我装的 userspace/CUDA 栈是 580.95.05。**版本要精确匹配**——你只换内核模块;CUDA、userspace 库、PyTorch 都不动。这是风险最低的做法:补丁模块不对劲就 `rmmod` / 还原原厂模块，立刻回去，无需重装 CUDA。备好原厂模块，你就有一条命令的回滚。

### 配置块(这台机器上的真实值)

**(a) Proxmox VM 配置** —— `q35` 机型 + 两张 GPU 作为 PCIe(`/etc/pve/qemu-server/<vmid>.conf`，节选与 P2P 相关的行):

```ini
machine: q35
cpu: host
# both 5090s, passed through as PCIe (not legacy PCI):
hostpci0: <gpu0-pci-addr>,pcie=1
hostpci1: <gpu1-pci-addr>,pcie=1
# (no vIOMMU line — do NOT add viommu=...; keep the guest without a virtual IOMMU)
```

> 等价的 `qm` 命令:
>
> ```bash
> qm set <vmid> --machine q35
> qm set <vmid> --cpu host
> qm set <vmid> --hostpci0 <gpu0-pci-addr>,pcie=1
> qm set <vmid> --hostpci1 <gpu1-pci-addr>,pcie=1
> ```
>
> 把 `<gpu0-pci-addr>` / `<gpu1-pci-addr>` 换成每张卡的 host PCI 地址(`lspci -nn | grep -i nvidia`)。

![Proxmox qm config:machine = q35，两张 GPU 以 hostpci0/hostpci1、pcie=1 直通](/assets/img/p2p-vfio/05-qm-config-q35-pcie.png)
_**图 5.** 这台 VM 的实时 `qm config`(只展示与 P2P 相关的行):`machine: q35`、`cpu: host`，两张 5090 都以 `hostpci0: ...,pcie=1` / `hostpci1: ...,pcie=1` 直通。这就是配方第 1–2 项的落地——`q35` 芯片组加 `pcie=1` 让两张卡在 guest 里以真正的 PCIe 设备出现。_

**(b) host 内核 cmdline** —— IOMMU 走 passthrough 模式(AMD host)。改 `/etc/default/grub` 里的 `GRUB_CMDLINE_LINUX_DEFAULT`，然后 `update-grub` 重启:

```bash
# /etc/default/grub
GRUB_CMDLINE_LINUX_DEFAULT="quiet amd_iommu=on iommu=pt"
```

> `amd_iommu=on` 开 IOMMU;`iommu=pt` 让它走 passthrough、host 不再重翻译(补丁的裸机前提)。Intel host 上对应 `intel_iommu=on iommu=pt`。

![host /proc/cmdline 显示 amd_iommu=on iommu=pt(PCI passthrough 模式)](/assets/img/p2p-vfio/06-host-cmdline-iommu-pt.png)
_**图 6.** 实时的 host `/proc/cmdline`，确认 `amd_iommu=on iommu=pt` 确实在运行内核上生效(连同 `pci=realloc`)。这是配方第 5 项——IOMMU 开着、但走 passthrough 模式，正是补丁的裸机逻辑所依赖的前提。_

**(c) 确保 VFIO 用 type1 后端、不用 IOMMUFD。** Proxmox 默认就是 type1，所以通常这一步是"什么都别做"。要点是*不*去开 IOMMUFD:

```bash
# Sanity-check that the legacy/type1 container is in use (this is the default).
# If you ever see iommufd referenced in the QEMU args for the VM, you've switched
# backends — revert it. QEMU docs: PCI P2P DMA is unsupported under IOMMUFD because
# it does not map hardware PCI BAR regions yet.
qm showcmd <vmid> | tr ' ' '\n' | grep -iE 'iommufd|vfio'
# Expect vfio-pci device entries WITHOUT an iommufd backend object.
```

**(d) BIOS 设置(MZ73-LM2)** —— 这些是固件开关，在 setup 里设好后重启:

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

> 重启后在 host *和* guest 里都验证:
>
> ```bash
> # BAR1 should read 32G, not 256M:
> lspci -vvv -s <gpu-pci-addr> | grep -i 'Region 1'
> ```
>
> BAR1 应读到 32G，不是 256M。

![BAR1 扩到 32G:lspci 显示 Region 1 size=32G、Resizable BAR current size 32GB](/assets/img/p2p-vfio/04-bar1-32g.png)
_**图 4.** BIOS"4G 以上 prefetchable MMIO"窗口起效的证据:`lspci -vvv` 显示 `Region 1: ... [size=32G]`，且 Physical Resizable BAR 能力显示 `BAR 1: current size: 32GB, supported: 32GB`。开箱状态下 BAR1 只有 256 MB;这块 32G aperture 正是 BAR1 上的 P2P DMA 写入的目标。这是整个配方里最常被跳过的一步。_

### 为什么 type1 而非 IOMMUFD，再说一遍

因为 P2P 需要把 peer BAR 映进 IOMMU 域，而 **IOMMUFD 目前还不映 BAR**。type1 映(而且"基本上一直在映")。这是整个配方里最反直觉的一句——*更新*的后端反而是把 P2P 弄坏的那个——所以值得说两遍。

### 为什么 BAR1 必须拉满，再说一遍

P2P 流量走 GPU-B 的 BAR1(它的 framebuffer aperture)。如果 BAR1 是默认的 256 MB，就没有 aperture 可供 DMA 写入，无论其他都对、你都会得到 NS 或一条残废的链路。32G 的 BAR1 完全受制于 BIOS 的"4G 以上 prefetchable MMIO"窗口，而那个窗口只能在 BIOS 里设。如果让我点名整个配方里最常被跳过的一步，就是这一步。

## 4. 证据

```text
$ nvidia-smi topo -p2p r
        GPU0    GPU1
 GPU0   X       OK
 GPU1   OK      X
```

(配方之前:每个非对角格都是 `NS`。)

![nvidia-smi topo -p2p 补丁前 vs 后:stock 驱动 NS → 补丁后 OK(读和写、双向)](/assets/img/p2p-vfio/01-p2p-topo.png)
_**图 1.** guest 内的 `nvidia-smi topo -p2p r/w`。stock NVIDIA 驱动下每个非对角格都是 `NS`(Not Supported——消费卡驱动对 GeForce P2P 的软件锁);换上 aikitoria 打补丁的 `580.95.05` 模块后，读和写、双向每一格都是 `OK`。这就是核心结果:P2P 在 VFIO 直通 VM 里跑通了。_

```python
>>> import torch
>>> torch.cuda.can_device_access_peer(0, 1), torch.cuda.can_device_access_peer(1, 0)
(True, True)
```

带宽(`p2pBandwidthLatencyTest` 那类测量):一个方向 **56.5 GB/s**，另一个方向 **56.4 GB/s**。一条干净的 PCIe 5.0 x16 P2P 链路。

![实测 P2P 带宽:双向 56.5 GB/s，走 PCIe Gen5 x16](/assets/img/p2p-vfio/02-p2p-bandwidth.png)
_**图 2.** 一个 torch GPU→GPU 拷贝基准(每方向 0.75 GiB 缓冲)，`can_device_access_peer` 双向均返回 `True`。实测 GPU0→GPU1 **56.5 GB/s**、GPU1→GPU0 **56.5 GB/s**——一条干净、对称的 PCIe 5.0 x16 P2P 链路，与社区在裸机上看到的 ~55 GB/s 对齐。_

正确性——我最在意的部分，因为 IOMMU 翻译下*几乎*对的 P2P 比完全没有 P2P 更糟:

- `arange`、`ones`、`randn` 三种张量，**各 1 GB**，GPU→GPU 来回拷，双向
- 每次往返都与源做 checksum 比对
- **全部通过。** 没有静默的地址错翻，没有腐败。

![P2P 往返数据正确性:arange / ones / randn 张量全部 torch.equal = True，ALL_PASS](/assets/img/p2p-vfio/03-p2p-data-correctness.png)
_**图 3.** 数据正确性检查:`arange`、`ones`、`randn` 三种张量各做 GPU0→GPU1→GPU0 往返拷贝，再用 `torch.equal` 与原值比对，三者均返回 `True`(`DATA_CORRECTNESS_ALL_PASS=True`)。这是最关键的一项测试——它证明 IOMMU 翻译下的 P2P 路径没有在静默地写到错误地址。_

我还在打了补丁的驱动上重启了一个真实的 CUDA 工作负载(一个自研 TTS/语音服务)，确认它正常加载和服务——也就是说，打补丁的内核模块对日常 CUDA 工作是安全的，不只是为了 P2P 测试。整套配置也能挺过 guest 重启:BIOS 窗口、GRUB `iommu=pt`、`pcie=1`、补丁模块全都持久。

## 5. 附录 —— 我真正想用这台机器做的事:32B 全参微调

P2P 是个有意思的结果，但老实说它和我的真实工作负载是相切的。我想知道在这台机器上**到底能不能全参微调一个 32B 模型**。剧透:能——而且值得注意的是，*这部分不用 P2P*。ZeRO 式的 CPU offload 在 GPU↔CPU-RAM 之间搬张量，不是 GPU↔GPU，所以下面的微调跑在普通 NCCL 上、即使关掉 P2P 也照跑。我把它放进来，是因为同一台机器、同一次会话，而且它是一个有用的"硬件到底够不够?"的数据点。

**配置:** 一个 ~32B 的 dense 模型，**bf16**，**DeepSpeed ZeRO-3、参数*和*优化器状态全部 offload 到 CPU**，跨两张 5090。全参，不是 LoRA。(注意:bf16，不是 int8——int8 是推理量化;全参权重更新需要精度。)

**实测，40 步运行，稳态排除前 5 个 warmup 步:**

| 指标 | 数值 |
|---|---|
| 模型 | ~32B params，dense |
| dtype | bf16 |
| 优化器 | AdamW (DeepSpeed cpu_adam, CPU offload)，lr 1e-4 |
| 并行 | DeepSpeed ZeRO-3，2 GPUs |
| Offload | param → CPU + optimizer → CPU (pinned) |
| 有效 batch | 2 (micro-bs 1 × accum 1 × 2 GPUs) |
| 序列长度 | 512 (1024 tokens/step) |
| **步时(稳态)** | **17.43 s ± 0.16 s** |
| **吞吐** | **58.7 tokens/s** |
| **显存峰值(本作业)** | **~10 GiB / 卡** |
| **内存峰值** | **~1.14 TiB committed** |

优化器确实经 offload 路径*在更新权重*的证据:固定 batch 过拟合(每步同一个 batch)把 loss 从 **11.64 压到 ~0.015**——大约三个数量级，warmup 之后单调下降。如果 offload 的优化器没有真的施加更新，loss 不会动。它动了。

![32B 全参微调:逐步 loss 表(11.64 → ~0.015)，17.43 s/step 稳态，58.7 tokens/s](/assets/img/p2p-vfio/07-32b-benchmark.png)
_**图 7.** 在一个 ~32B dense 模型上做全参微调的真实 40 步运行(bf16，DeepSpeed ZeRO-3、参数与优化器全部 offload 到 CPU，跨两张 5090)。逐步 loss 表显示固定 batch 过拟合把 loss 从 **11.64** 单调压到 **~0.015**，汇总确认稳态 **17.43 s/step**、**58.7 tokens/s**、~10 GiB 显存/卡、~1.14 TiB 内存峰值。注意:这个工作负载跑在普通 NCCL 上，*不*使用 P2P。_

**诚实的解读:** 这是 **offload 慢路径**。~17.4 s/step、~59 tokens/s 不是一个高吞吐训练配置——它回答的是"一台带两张消费卡的单机到底*能不能* 做 32B 全参微调?"，答案是能。让它成为可能的诀窍是那个不对称:参数和优化器状态驻留在 CPU RAM，**GPU 占用塌缩到 ~10 GiB/卡**(GPU 只持有当前层加上激活)，而**代价转移到 ~1.14 TiB 的 RAM**(bf16 参数 + fp32 Adam 的 m/v 状态)。这就是那个权衡——显存受限变成内存受限——也是为什么一台大内存 EPYC 机器(12 通道 DDR5、1 TB)即便只有"区区"32 GB 的卡也是这个工作负载的正确形态。

**两个值得标出的复现陷阱:**

- **ninja 必须在 PATH 上。** DeepSpeed 的 `cpu_adam` 算子在第一步 JIT 编译，需要找得到 `ninja` 二进制;如果它装在一个不在 PATH 上的 venv bin 里，你会得到 `Unable to JIT load the cpu_adam op`。启动前把 venv bin 导出到 PATH。
- **必须在 ZeRO-3 init context 下加载模型。** 实例化 `HfDeepSpeedConfig(ds_config)` 并让它在 `from_pretrained` *之前*保持存活，这样 32B 模型在构造时就被分片。一个普通的 `from_pretrained` 会试图把整个 ~64 GB 的 bf16 模型放到一张卡上，训练还没开始就 OOM。

## 6. 致谢与"哪里是新的"的精确边界

直白地说，免得有人误会贡献在哪:

- **P2P 软件解锁不是我的。** 是 aikitoria 打补丁的 `open-gpu-kernel-modules`，它建立在 tinygrad 早期解除 NVIDIA GeForce P2P 锁的工作之上。只要你跑消费卡 P2P，无论裸机还是 VM，扛重活的都是那个补丁。
- **裸机配方和 BAR 扩容的知识在 homelab / ML-systems 社区是成熟的**(smcleod 的教程等)。我是沿着他们的路走的。
- **我唯一的增量是 VM 这部分:** 证明*同样*的解锁能**在 VFIO 直通 guest 里跑通**——用 type1 后端 / 无 vIOMMU / host `iommu=pt` / 补丁只用于解软锁这套框架——外加*为什么*的机制解释(VFIO 原生的 peer-BAR 翻译扛着它，不需要 ATS)，以及一个"它没在静默错翻"的正确性检查。

我想谨慎地**不**把这个吹成"解锁了消费卡 P2P"——那已经被比我聪明的人解锁了。缺的是一个做过、查过正确性、能挺过进入直通 VM 这趟旅程的实例，且对抗着一个近乎一致的"它做不到"的共识。那个缺口现在补上了，带着配方。把这条线划清楚，我认为，才是让结果可信、而不是又一个上气不接下气的 homelab 标题党的原因。

如果你在不同的板子或驱动版本上复现了，我真心想知道——尤其是 type1 的 peer-BAR 映射在 Intel host 上行为是否相同、以及两张卡挂在不同 root port 下时带宽是否还稳得住。

## 引用

- **aikitoria**，打补丁的 `open-gpu-kernel-modules`(`580.95.05-p2p` tag)—— 这里用到的 GeForce P2P 软件解锁。
- **tinygrad** —— 更早解除 NVIDIA GeForce P2P 锁的工作，补丁建立在其上。
- **smcleod** 与更广的 homelab / ML-systems 社区 —— 裸机多卡 5090 P2P 配方与 BAR 扩容知识。
- **Alex Williamson**(VFIO 维护者)—— 描述 VFIO type1 的 peer-BAR 映射"基本上一直存在"的内核邮件列表帖。
- **QEMU 文档** —— 指出 IOMMUFD 后端下不支持 PCI P2P DMA(它目前还不映射硬件 PCI BAR 区域)。

---

> 本文每条论点均附真实终端证据图(本机渲染、已脱敏)。
{: .prompt-tip }
