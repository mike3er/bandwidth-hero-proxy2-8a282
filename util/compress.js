const sharp = require("sharp");

function compress(input, useWebp, grayscale, quality, originalSize, maxWidth) {
  const format = useWebp ? "webp" : "jpeg";

  let pipeline = sharp(input);

  if (maxWidth > 0) {
    pipeline = pipeline.resize({
      width:              maxWidth,
      withoutEnlargement: true,
      fit:                "inside",
    });
  }

  pipeline = pipeline.grayscale(grayscale);

  if (useWebp) {
    pipeline = pipeline.webp({
      quality,
      effort: 0,
    });
  } else {
    pipeline = pipeline.jpeg({
      quality,
      progressive:   true,
      optimizeScans: true,
    });
  }

  return pipeline
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => ({
      err: null,
      headers: {
        "content-type":    `image/${format}`,
        "content-length":  info.size,
        "x-original-size": originalSize,
        "x-bytes-saved":   originalSize - info.size,
      },
      output: data,
    }))
    .catch((err) => ({ err }));
}

module.exports = compress;