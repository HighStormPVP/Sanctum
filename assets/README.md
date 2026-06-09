# Icon assets

electron-builder looks for the following files here at build time:

- `icon.icns` — macOS app + DMG icon (1024×1024+, multi-resolution)
- `icon.ico` — Windows installer + .exe icon (multi-resolution)
- `icon.png` — Linux AppImage icon (512×512+)

If any are missing, the build falls back to the default Electron logo. Fine for testing, not great for shipping.

## Generating from a single PNG

If you have one square high-res PNG (`logo.png`, 1024×1024):

### macOS
```bash
mkdir icon.iconset
sips -z 16 16     logo.png --out icon.iconset/icon_16x16.png
sips -z 32 32     logo.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32     logo.png --out icon.iconset/icon_32x32.png
sips -z 64 64     logo.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128   logo.png --out icon.iconset/icon_128x128.png
sips -z 256 256   logo.png --out icon.iconset/icon_128x128@2x.png
sips -z 256 256   logo.png --out icon.iconset/icon_256x256.png
sips -z 512 512   logo.png --out icon.iconset/icon_256x256@2x.png
sips -z 512 512   logo.png --out icon.iconset/icon_512x512.png
cp logo.png       icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset -o icon.icns
```

### Windows / cross-platform
Use [icoconvert.com](https://icoconvert.com) or `magick logo.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico`.

### Linux
Just copy your high-res PNG to `icon.png`.
