(function() {
  async function decode(buffer) {
    var bytes = new Uint8Array(buffer), view = new DataView(buffer), parts = [], w = 0, h = 0, channels = 0;
    var signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 33 || signature.some(function(b, i) { return bytes[i] !== b; })) throw new Error('Invalid published PNG');
    for (var offset = 8; offset + 12 <= bytes.length;) {
      var size = view.getUint32(offset), end = offset + 12 + size;
      if (end > bytes.length) throw new Error('Truncated published PNG');
      var type = String.fromCharCode.apply(null, bytes.subarray(offset + 4, offset + 8));
      if (type === 'IHDR') {
        w = view.getUint32(offset + 8); h = view.getUint32(offset + 12);
        channels = { 0: 1, 2: 3, 6: 4 }[bytes[offset + 17]];
        if (size !== 13 || bytes[offset + 16] !== 8 || !channels || bytes[offset + 20] !== 0)
          throw new Error('Expected non-interlaced grayscale, RGB or RGBA8 PNG');
      } else if (type === 'IDAT') parts.push(bytes.subarray(offset + 8, offset + 8 + size));
      else if (type === 'IEND') break;
      offset = end;
    }
    if (!(w > 0 && h > 0) || w * h > 33554432 || !parts.length) throw new Error('Invalid published PNG dimensions');
    var stream = new Blob(parts).stream().pipeThrough(new DecompressionStream('deflate'));
    var rows = new Uint8Array(await new Response(stream).arrayBuffer());
    var stride = w * channels, samples = new Uint8Array(stride * h);
    if (rows.length !== (stride + 1) * h) throw new Error('Published PNG pixel count mismatch');
    for (var y = 0; y < h; y++) {
      var src = y * (stride + 1), dst = y * stride, filter = rows[src];
      if (filter !== 0 && filter !== 1) throw new Error('Unsupported published PNG filter');
      for (var x = 0; x < stride; x++)
        samples[dst + x] = (rows[src + x + 1] + (filter === 1 && x >= channels ? samples[dst + x - channels] : 0)) & 255;
    }
    var pixels = new Uint8ClampedArray(w * h * 4);
    for (var i = 0, j = 0; i < samples.length; i += channels, j += 4) {
      pixels[j] = samples[i];
      pixels[j + 1] = samples[i + (channels === 1 ? 0 : 1)];
      pixels[j + 2] = samples[i + (channels === 1 ? 0 : 2)];
      pixels[j + 3] = channels === 4 ? samples[i + 3] : 255;
    }
    return { w: w, h: h, pixels: pixels };
  }
  async function load(url, publication) {
    var urls = [url];
    if (publication.alpha_file) urls.push(new URL(publication.alpha_file, url).href);
    var frames = await Promise.all(urls.map(async function(address) {
      var response = await fetch(address);
      if (!response.ok) throw new Error('Published PNG fetch failed: ' + address);
      return decode(await response.arrayBuffer());
    }));
    var frame = frames[0], alpha = frames[1];
    if (alpha) {
      if (alpha.w !== frame.w || alpha.h !== frame.h) throw new Error('Published alpha dimensions mismatch');
      for (var i = 3; i < frame.pixels.length; i += 4) frame.pixels[i] = alpha.pixels[i - 3];
    }
    return frame;
  }
  window.PublishedTexture = { decode: decode, load: load };
})();
