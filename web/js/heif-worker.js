// Decodes HEIC/HEIF off the main thread.
//
// libheif is a 2 MB WebAssembly module and decoding a 12-megapixel iPhone
// photo takes a second or two. On the main thread that is a frozen page; here
// it is a spinner that keeps spinning.
//
// Receives { id, bytes } and replies with { id, width, height, pixels } or
// { id, error }. The pixel buffer is transferred rather than copied.

let ready = null;

function load() {
  if (!ready) {
    ready = import('../vendor/libheif/libheif-bundle.mjs')
      .then(mod => (typeof mod.default === 'function' ? mod.default() : mod.default))
      .then(lib => lib.HeifDecoder ? lib : (lib.default || lib));
  }
  return ready;
}

self.onmessage = async (event) => {
  const { id, bytes } = event.data;
  try {
    const libheif = await load();
    const decoder = new libheif.HeifDecoder();
    const images = decoder.decode(new Uint8Array(bytes));
    if (!images || images.length === 0) {
      throw new Error('No image inside this HEIC file');
    }
    // A HEIC can hold a burst or a Live Photo; the first image is the picture.
    const image = images[0];
    const width = image.get_width();
    const height = image.get_height();
    if (!width || !height) throw new Error('This HEIC file has no usable image');

    const pixels = new Uint8ClampedArray(width * height * 4);
    await new Promise((resolve, reject) => {
      image.display({ data: pixels, width, height }, out => {
        if (out) resolve();
        else reject(new Error('Could not decode this HEIC image'));
      });
    });
    if (typeof image.free === 'function') image.free();

    self.postMessage({ id, width, height, pixels }, [pixels.buffer]);
  } catch (err) {
    self.postMessage({ id, error: err && err.message ? err.message : String(err) });
  }
};
