# CLAUDE.md

## Project Overview

Hugo static blog (https://mr0ptimist.github.io/) using the PaperMod theme as a git submodule. Content is in Chinese, focused on graphics rendering, GPU optimization, and game engine internals. Deployed to GitHub Pages via GitHub Actions on push to `main`.

## Development Commands

```bash
hugo server -D                  # Local preview (includes drafts)
hugo                            # Build to public/
python scripts/new-post.py              # Interactive post creation — creates Page Bundle (文章名/index.md + context.json)
python scripts/organize_post_images.py  # Organize post images into Page Bundles with compression
python scripts/organize_post_images.py --dry-run  # Preview plan without executing
python scripts/organize_post_images.py --post "文章名"  # Only process a specific post
```

Equivalent `.bat` files in `bat/`: `serve_启动预览.bat`, `build_构建发布.bat`, `new-post_新建文章.bat`, `clean_清除输出.bat`, `organize_images_整理贴图.bat`.

Hugo version: 0.160.1 extended.

## Architecture

- **Theme**: PaperMod imported as git submodule at `themes/PaperMod` — never modify theme files directly
- **Customization**: All overrides go in `layouts/_partials/`, `layouts/` (root templates), `assets/css/extended/`, and `archetypes/`
- **Client-side features** in `layouts/_partials/extend_footer.html`:
  - Auto-collapsible `##` headings (details/summary) — don't add manual `<details>` tags around `##`
  - Password-protected posts (`hidden: true` front matter, unlocked via nav bar)
  - Responsive width slider + TOC width slider (persisted in sessionStorage)
  - TOC auto-filtering (hides deeply nested headings, highlights active section)
- **DDS/EXR Direct Viewer**: browser-side pixel decode + WebGL display. No preview PNGs needed — reference DDS/EXR files directly in markdown. Implementation details in `static/js/CLAUDE.md`.
- **Auto-restart**: after editing any file in this project, Claude must restart `hugo server` so changes take effect immediately. Hugo server 在 watch 模式下会自动重载，无需手动重启。
- **Custom header**: `layouts/_partials/header.html` (theme toggle, width controls, secret unlock button)

## Content Rules

Full writing guidelines in `content/posts/CLAUDE.md`. Critical operational rules:

- Front matter uses **TOML** (`+++` delimiters), not YAML
- **context.json**: every Page Bundle has a `context.json` — **read it before working on any article** to find relevant source code and RDC file paths
- **All `##` headings auto-collapse** via JS — never wrap them in `<details>` HTML
- **Local-only content**: `content/local/` is ignored by production builds; same Page Bundle structure as `content/posts/`
