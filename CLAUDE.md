# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hugo static blog (https://mr0ptimist.github.io/) using the PaperMod theme as a git submodule. Content is in Chinese, focused on graphics rendering, GPU optimization, and game engine internals. Deployed to GitHub Pages via GitHub Actions on push to `main`.

## Development Commands

```bash
hugo server -D                  # Local preview (includes drafts)
hugo                            # Build to public/
python new-post.py              # Interactive post creation with tag/category suggestions
python organize_post_images.py  # Organize post images into Page Bundles with compression
python organize_post_images.py --dry-run  # Preview plan without executing
python organize_post_images.py --post "文章名"  # Only process a specific post
```

Equivalent `.bat` files in `bat/`: `serve_启动预览.bat`, `build_构建发布.bat`, `new-post_新建文章.bat`, `clean_清除输出.bat`, `organize_images_整理贴图.bat`.

Hugo version: 0.160.1 extended.

## Architecture

- **Theme**: PaperMod imported as git submodule at `themes/PaperMod` — never modify theme files directly
- **Customization**: All overrides go in `layouts/` (partials), `assets/css/extended/`, and `archetypes/`
- **Client-side features** in `layouts/partials/extend_footer.html`:
  - Auto-collapsible `##` headings (details/summary) — don't add manual `<details>` tags around `##`
  - Password-protected posts (`hidden: true` front matter, unlocked via nav bar)
  - Responsive width slider + TOC width slider (persisted in sessionStorage)
  - TOC auto-filtering (hides deeply nested headings, highlights active section)
- **Custom CSS**: `assets/css/extended/collapsible.css` and `encryption.css`
- **Custom header**: `layouts/partials/header.html` (theme toggle, width controls, secret unlock button)

## Content Rules

Content writing guidelines are in `content/posts/CLAUDE.md`. Key points:

- Front matter uses **TOML** format with `+++` delimiters (not YAML `---`)
- Required fields: `date` (ISO 8601 with timezone), `draft`, `title`, `tags`, `categories`
- `hidden: true` makes a post password-protected
- Reuse existing tags/categories (see `content/posts/CLAUDE.md` for lists)
- Research articles must cite sources with links; verify all URLs are accessible before including them
- Images use Hugo Page Bundles: post images go in `content/posts/{post-name}/` alongside `index.md`, referenced as relative paths — run `organize_post_images.py` after pasting images
- All `##` headings auto-collapse via JS — don't wrap them in additional `<details>` HTML
