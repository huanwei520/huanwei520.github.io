---
# English posts section — always present, lists only English-language posts.
# Section display name is a translatable language label: "English" in EN UI,
# "英文" in ZH UI — mirrors the Chinese section in _tabs/zh.md ("Chinese" / "中文")
# so the two language-region tabs are symmetric and follow the UI language
# (nav reads «English · Chinese» in EN, «英文 · 中文» in ZH). The lang filter below
# (where lang == 'en') is unchanged and still lists English posts.
title: English
title_zh: 英文
layout: page
icon: fas fa-e
order: 4
toc: false
---

<!-- Bilingual section intro: both strings rendered into the DOM; CSS (i18n.css) shows the
     one matching html[data-lang], set synchronously in <head> before paint — so no flash. -->
<p class="lang-section-intro" data-i18n="section.en.intro"><span data-i18n-lang="en">English-language posts.</span><span data-i18n-lang="zh">英文文章。</span></p>

<div id="post-list" class="flex-grow-1 px-xl-1">
  {% assign en_posts = site.posts | where: 'lang', 'en' %}
  {% for post in en_posts %}
    <article class="card-wrapper card">
      <a href="{{ post.url | relative_url }}" class="post-preview row g-0 flex-md-row-reverse">
        <div class="col-md-12">
          <div class="card-body d-flex flex-column">
            <h1 class="card-title my-2 mt-md-0">{{ post.title }}</h1>
            <div class="card-text content mt-0 mb-3">
              <p>{% include post-summary.html %}</p>
            </div>
            <div class="post-meta flex-grow-1 d-flex align-items-end">
              <div class="me-auto">
                <i class="far fa-calendar fa-fw me-1"></i>
                {% include datetime.html date=post.date wrap='time' class='timeago' %}
                {% if post.categories.size > 0 %}
                  <i class="far fa-folder-open fa-fw me-1"></i>
                  <span class="categories">
                    {% for category in post.categories %}
                      {{ category }}
                      {%- unless forloop.last -%},{%- endunless -%}
                    {% endfor %}
                  </span>
                {% endif %}
              </div>
            </div>
          </div>
        </div>
      </a>
    </article>
  {% endfor %}
</div>
