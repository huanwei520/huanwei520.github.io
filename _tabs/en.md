---
# English posts section — always present, lists only English-language posts.
title: English
title_zh: 英文
layout: page
icon: fas fa-e
order: 4
toc: false
---

<!-- Bilingual section intro: both strings present; JS i18n toggle shows the active one. -->
<p class="lang-section-intro">
  <span data-i18n="section.en.intro" data-i18n-en="English-language posts." data-i18n-zh="英文文章。">English-language posts.</span>
</p>

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
