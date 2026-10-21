/**
 * Bandwidth Hero Proxy — Netlify Serverless Function
 *
 * Original proxy concept: ayastreb/bandwidth-hero-proxy (MIT)
 * Serverless port:        adi-g15/bandwidth-hero-proxy (MIT)
 * This repo:              himshim/bandwidth-hero-proxy2 (MIT)
 */

const pick           = require("../util/pick");
const fetch          = require("node-fetch");
const shouldCompress = require("../util/shouldCompress");
const compress       = require("../util/compress");

const DEFAULT_QUALITY = 40;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// Cache-Control: Netlify CDN caches each compressed response at the edge.
// The cache key is the full proxy URL (includes url + quality + bw + jpeg + max_width)
// so every unique param combination gets its own cache entry.
// CDN cache hits never invoke this function at all.
const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=604800, max-age=3600, stale-while-revalidate=86400",
};

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isPrivateHost(hostname) {
  return [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^169\.254\./,
    /^::1$/,
  ].some((p) => p.test(hostname));
}

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    if (response.ok) {
      const body = await response.buffer();
      const contentLength = response.headers.get("content-length");
      const expectedBytes = contentLength && /^\d+$/.test(contentLength)
        ? Number(contentLength)
        : null;

      console.log("[upstream-body-diagnostic]", JSON.stringify({
        status: response.status,
        contentType: response.headers.get("content-type"),
        contentLength,
        actualBytes: body.length,
        lengthMatches: expectedBytes === null ? "unknown" : expectedBytes === body.length
      }));

      response._bandwidthHeroBody = body;
    }

    return response;
  } catch (err) {
    if (controller.signal.aborted) {
      const timeoutError = new Error("FETCH_TIMEOUT");
      timeoutError.cause = err;
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async (e) => {
  if (e.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  let { url: r } = e.queryStringParameters;

  // jpeg:      "1" = use JPEG (client has no WebP), "0" or absent = use WebP
  // bw:        "1" = grayscale, "0" or absent = colour
  // quality/l: compression quality 1–100.
  //            Our extension sends "quality=", original ayastreb sends "l=".
  //            Both accepted so this proxy works with either extension.
  // max_width: downscale images wider than this before compressing, 0 = no limit.
  //            Our extension sends this; original extension does not — safe to ignore.
  const { jpeg: s, bw: o, quality: q, l, max_width: mw } = e.queryStringParameters;

  if (!r) {
    return { statusCode: 200, headers: CORS_HEADERS, body: "bandwidth-hero-proxy" };
  }

  try { r = JSON.parse(r); } catch {}
  Array.isArray(r) && (r = r.join("&url="));
  r = r.replace(/http:\/\/1\.1\.\d\.\d\/bmi\/(https?:\/\/)?/i, "http://");

  if (!isValidUrl(r)) {
    return { statusCode: 400, headers: CORS_HEADERS, body: "Invalid URL" };
  }
  const parsedUrl = new URL(r);
  if (isPrivateHost(parsedUrl.hostname)) {
    return { statusCode: 403, headers: CORS_HEADERS, body: "Forbidden" };
  }

  // useWebp: true unless client explicitly sent jpeg=1.
  // Original proxy used `!s` which treated both "0" and "1" as truthy strings
  // and always returned WebP. Fixed with strict string comparison.
  const useWebp = s !== "1";

  // grayscale: only true when bw is explicitly "1".
  // Original proxy used loose `0 != o` coercion — same result, made explicit here.
  const grayscale = o === "1";

  // Accept both param names for compatibility with original and our extension.
  const quality  = parseInt(q || l, 10) || DEFAULT_QUALITY;

  const parsedMaxWidth = Number.parseInt(mw, 10);
  const maxWidth =
    mw === undefined || mw === null || mw === "" ||
    !Number.isFinite(parsedMaxWidth)
      ? 1500
      : parsedMaxWidth;

  try {
    let upstreamHeaders = {}, body, contentType;
    const requestStartedAt = Date.now();
    let upstreamMs = 0;

    try {
      const response = await fetchWithTimeout(
        r,
        {
          headers: {
            ...pick(e.headers, ["cookie", "dnt", "referer"]),
            "user-agent":
              e.headers["user-agent"] ||
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "accept":
              e.headers["accept"] ||
              "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "accept-language": e.headers["accept-language"] || "en-US,en;q=0.9",
            "accept-encoding": "identity",
            "x-forwarded-for": e.headers["x-forwarded-for"] || e.ip,
            via: "1.1 bandwidth-hero",
          },
          redirect: "follow",
        },
        40000
      );
      // fetchWithTimeout buffers successful bodies, so this includes the
      // upstream response and full image download time.
      upstreamMs = Date.now() - requestStartedAt;
      console.log(`[proxy-timing] upstream=${upstreamMs}ms status=${response.status}`);

      if (!response.ok) {
        return { statusCode: response.status || 302, headers: CORS_HEADERS, body: "" };
      }

      upstreamHeaders = response.headers;
      body            = response._bandwidthHeroBody;
      contentType     = response.headers.get("content-type") || "";

    } catch (fetchErr) {
      if (fetchErr.message === "FETCH_TIMEOUT") {
        return { statusCode: 504, headers: CORS_HEADERS, body: "Upstream fetch timed out" };
      }
      throw fetchErr;
    }

    if (contentType && !contentType.startsWith("image/")) {
      let detectedImage;

      try {
        const metadata = await require("sharp")(body).metadata();

        detectedImage = {
          format: metadata.format || null,
          width: metadata.width || null,
          height: metadata.height || null,
        };
      } catch (imageErr) {
        detectedImage = {
          error: imageErr.message,
        };
      }

      console.log("[mime-diagnostic]", JSON.stringify({
        reportedType: contentType,
        detectedImage,
        bytes: body.length,
      }));

      return {
        statusCode: 415,
        headers:    CORS_HEADERS,
        body:       `Upstream returned non-image response (${contentType})`,
      };
    }

    const originalSize = body.length;

    // useWebp doubles as the isTransparent flag: WebP supports transparency so
    // the lower 1024-byte minimum threshold applies in WebP mode, meaning almost
    // all images get compressed. In JPEG mode the higher PNG/GIF threshold applies.
    if (!shouldCompress(contentType, originalSize, useWebp)) {
      console.log("Bypassing compression. Size:", originalSize);
      return {
        statusCode:      200,
        body:            body.toString("base64"),
        isBase64Encoded: true,
        headers: {
          ...CORS_HEADERS,
          ...CACHE_HEADERS,
          "content-encoding": "identity",
          ...upstreamHeaders,
        },
      };
    }

    const compressionStartedAt = Date.now();
    const { err, output, headers: compressedHeaders } = await compress(
      body, useWebp, grayscale, quality, originalSize, maxWidth
    );
    const compressionMs = Date.now() - compressionStartedAt;

    if (err) {
      console.log("Compression failed:", r);
      throw err;
    }

    console.log(
      `[proxy-timing] upstream=${upstreamMs}ms compression=${compressionMs}ms input=${originalSize}B output=${output.length}B`
    );
    console.log(
      `From ${originalSize}, saved: ${((originalSize - output.length) / originalSize * 100).toFixed(1)}%`
    );

    return {
      statusCode:      200,
      body:            output.toString("base64"),
      isBase64Encoded: true,
      headers: {
        ...CORS_HEADERS,
        ...CACHE_HEADERS,
        "Server-Timing": `upstream;dur=${upstreamMs}, compress;dur=${compressionMs}`,
        "content-encoding": "identity",
        ...upstreamHeaders,
        ...compressedHeaders,
      },
    };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: CORS_HEADERS, body: err.message || "" };
  }
};