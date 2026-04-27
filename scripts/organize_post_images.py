import os, re, argparse, shutil
from PIL import Image
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
POSTS_DIR = PROJECT_ROOT / "content" / "posts"
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff", ".tif"}
MAX_WIDTH = 1920
WEBP_QUALITY = 80


def scan_posts():
    md_files = {}
    image_files = {}
    for f in POSTS_DIR.iterdir():
        if not f.is_file():
            continue
        if f.suffix.lower() == ".md" and f.name != "CLAUDE.md":
            md_files[f.stem] = f
        elif f.suffix.lower() in IMAGE_EXTS:
            image_files[f.name] = f
    return md_files, image_files


def parse_image_refs(md_path):
    text = md_path.read_text(encoding="utf-8")
    refs = re.findall(r"!\[.*?\]\(([^)]+)\)", text)
    result = []
    for ref in refs:
        if ref.startswith(("http://", "https://", "data:", "#", "mailto:")):
            continue
        clean = ref.lstrip("./")
        if clean.startswith("/"):
            continue
        result.append((ref, clean))
    return result


def check_alpha(img):
    if img.mode in ("RGBA", "LA", "PA"):
        if img.mode == "RGBA":
            alpha = img.getchannel("A")
            extrema = alpha.getextrema()
            return extrema != (255, 255)
        return True
    return False


def compress_image(src, dst):
    img = Image.open(src)
    original_mode = img.mode
    has_alpha = check_alpha(img)

    if img.width > MAX_WIDTH:
        ratio = MAX_WIDTH / img.width
        new_size = (MAX_WIDTH, int(img.height * ratio))
        img = img.resize(new_size, Image.LANCZOS)

    dst_path = Path(dst)

    if has_alpha:
        dst_path = dst_path.with_suffix(".png")
        img.save(dst_path, "PNG", optimize=True)
        return dst_path.name
    else:
        if img.mode in ("RGBA", "LA", "PA"):
            bg = Image.new("RGB", img.size, (255, 255, 255))
            bg.paste(img, mask=img.convert("RGBA").getchannel("A"))
            img = bg
        elif img.mode != "RGB":
            img = img.convert("RGB")

        dst_path = dst_path.with_suffix(".webp")
        img.save(dst_path, "WEBP", quality=WEBP_QUALITY)
        return dst_path.name


def build_plan(md_files, image_files, target_post=None):
    ref_map = {}
    for stem, md_path in md_files.items():
        if target_post and stem != target_post:
            continue
        refs = parse_image_refs(md_path)
        local_refs = [(orig, clean) for orig, clean in refs if clean in image_files]
        if local_refs:
            ref_map[stem] = (md_path, local_refs)

    image_owners = {}
    for stem, (md_path, refs) in ref_map.items():
        for orig, clean in refs:
            image_owners.setdefault(clean, []).append(stem)

    shared_images = {img: owners for img, owners in image_owners.items() if len(owners) > 1}

    orphaned = []
    for name in image_files:
        if name not in image_owners:
            orphaned.append(name)

    return ref_map, shared_images, orphaned


def execute_plan(ref_map, image_files, dry_run=False):
    results = []
    for stem, (md_path, refs) in ref_map.items():
        bundle_dir = POSTS_DIR / stem
        index_md = bundle_dir / "index.md"

        conflicts = [clean for orig, clean in refs if clean in {}]
        if conflicts:
            continue

        if dry_run:
            print(f"\n  [DRY-RUN] {stem}/")
            print(f"    {md_path.name} -> {stem}/index.md")
            for orig, clean in refs:
                new_name = Path(clean).stem + ".webp"
                print(f"    {clean} -> {stem}/{new_name} (compress)")
            continue

        bundle_dir.mkdir(exist_ok=True)

        text = md_path.read_text(encoding="utf-8")
        replacements = {}

        for orig, clean in refs:
            src = image_files[clean]
            dst = bundle_dir / clean
            new_name = compress_image(src, dst)
            replacements[orig] = new_name
            src_bak = src.with_suffix(src.suffix + ".bak")
            if not src_bak.exists():
                src.rename(src_bak)

        for old, new in replacements.items():
            text = text.replace(old, new)

        index_md.write_text(text, encoding="utf-8")

        md_bak = md_path.with_suffix(md_path.suffix + ".bak")
        if not md_bak.exists():
            md_path.rename(md_bak)

        results.append((stem, len(refs)))

    return results


def main():
    parser = argparse.ArgumentParser(description="Organize post images into Hugo Page Bundles with compression")
    parser.add_argument("--dry-run", action="store_true", help="Show plan without executing")
    parser.add_argument("--post", type=str, help="Only process a specific post (stem name without .md)")
    args = parser.parse_args()

    print(f"Scanning {POSTS_DIR} ...")
    md_files, image_files = scan_posts()
    print(f"  Found {len(md_files)} posts, {len(image_files)} images")

    ref_map, shared_images, orphaned = build_plan(md_files, image_files, args.post)

    if not ref_map:
        print("\nNo posts with local image references found.")
        return

    print(f"\nPosts to organize: {len(ref_map)}")
    for stem, (md_path, refs) in ref_map.items():
        print(f"  {stem}/ ({len(refs)} images)")

    if shared_images:
        print(f"\nShared images (not moved, needs manual handling):")
        for img, owners in shared_images.items():
            print(f"  {img} <- referenced by {', '.join(owners)}")

    if orphaned:
        print(f"\nOrphaned images (not referenced by any post):")
        for img in orphaned:
            print(f"  {img}")

    print()
    results = execute_plan(ref_map, image_files, args.dry_run)

    if not args.dry_run:
        print("Results:")
        for stem, count in results:
            print(f"  {stem}/: {count} images compressed -> Page Bundle")
        print("\nOriginals preserved as .bak files. Delete after verification.")


if __name__ == "__main__":
    main()
