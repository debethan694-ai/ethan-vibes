import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand
} from "@aws-sdk/client-s3";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const CHUNK_MAX = 8 * 1024 * 1024;
const MAX_FILE_SIZE = CHUNK_MAX * 10000;

const ALLOWED_TYPES = new Set([
  "audio/mpeg", "audio/mp3", "audio/mp4", "audio/aac",
  "audio/ogg", "audio/opus", "audio/wav", "audio/x-wav", "audio/flac",
  "video/mp4", "video/webm", "video/quicktime",
  "video/x-matroska", "video/mpeg"
]);

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers }
  });
}

function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return b64url(await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(text)
  ));
}

async function sessionToken(env) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({
    role: "ceo",
    exp: Date.now() + 8 * 60 * 60 * 1000
  })));
  return `${payload}.${await hmac(env.SESSION_SECRET, payload)}`;
}

async function authenticated(request, env) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)ev_session=([^;]+)/);

  if (!match || !env.SESSION_SECRET) return false;

  const [payload, signature] = match[1].split(".");
  if (!payload || !signature) return false;

  if (signature !== await hmac(env.SESSION_SECRET, payload)) return false;

  try {
    const encoded = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = encoded + "=".repeat((4 - encoded.length % 4) % 4);
    const data = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(padded), c => c.charCodeAt(0))
    ));
    return data.role === "ceo" && data.exp > Date.now();
  } catch {
    return false;
  }
}

function cookie(value, maxAge) {
  return `ev_session=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function safeText(value, max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

function safeId() {
  return crypto.randomUUID();
}

function safeKey(id, fileName) {
  const ext = (fileName.split(".").pop() || "bin")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 10) || "bin";
  return `media/${id}.${ext}`;
}

function sameOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  return origin === new URL(request.url).origin &&
    (!env.SITE_ORIGIN || origin === env.SITE_ORIGIN);
}

async function requireCEO(request, env) {
  if (!await authenticated(request, env))
    return json({ error: "CEO sign-in required" }, 401);

  if (!sameOrigin(request, env))
    return json({ error: "Origin rejected" }, 403);

  return null;
}

function contentDisposition(name, attachment = false) {
  const clean = String(name || "media")
    .replace(/[\r\n"\\]/g, "_")
    .slice(0, 150);

  return `${attachment ? "attachment" : "inline"}; filename="${clean}"`;
}

function storageConfigured(env) {
  return !!(
    env.FILEBASE_BUCKET &&
    env.FILEBASE_ACCESS_KEY_ID &&
    env.FILEBASE_SECRET_ACCESS_KEY
  );
}

function storage(env) {
  if (!storageConfigured(env))
    throw new Error("Filebase configuration is missing");

  return new S3Client({
    region: "auto",
    endpoint: "https://s3.filebase.io",
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.FILEBASE_ACCESS_KEY_ID,
      secretAccessKey: env.FILEBASE_SECRET_ACCESS_KEY
    }
  });
}

async function publicMedia(env) {
  const { results = [] } = await env.DB.prepare(
    `SELECT id,title,artist,description,category,content_type,
    file_size,allow_download,created_at
    FROM media WHERE published=1
    ORDER BY created_at DESC LIMIT 300`
  ).all();

  return results.map(m => ({
    ...m,
    allow_download: !!m.allow_download
  }));
}

function emptyRange(size) {
  return new Response(null, {
    status: 416,
    headers: { "content-range": `bytes */${size}` }
  });
}

function responseBody(body) {
  if (!body) return null;
  if (typeof body.transformToWebStream === "function")
    return body.transformToWebStream();
  return body;
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/health" && method === "GET") {
    return json({
      ok: true,
      configured: !!(
        env.DB &&
        storageConfigured(env) &&
        env.CEO_PASSWORD &&
        env.SESSION_SECRET
      )
    });
  }

  if (path === "/api/media" && method === "GET") {
    try {
      return json(
        await publicMedia(env),
        200,
        { "cache-control": "public, max-age=60" }
      );
    } catch {
      return json({ error: "Database is not configured yet" }, 503);
    }
  }

  if (path === "/api/login" && method === "POST") {
    if (!sameOrigin(request, env))
      return json({ error: "Origin rejected" }, 403);

    if (!env.CEO_PASSWORD || !env.SESSION_SECRET)
      return json({ error: "CEO login is not configured" }, 503);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid request" }, 400);
    }

    const password = String(body.password || "");

    if (password.length < 12 || password !== env.CEO_PASSWORD)
      return json({ error: "Incorrect password" }, 401);

    const token = await sessionToken(env);

    return json(
      { authenticated: true },
      200,
      {
        "set-cookie": cookie(token, 8 * 60 * 60),
        "cache-control": "no-store"
      }
    );
  }

  if (path === "/api/logout" && method === "POST") {
    if (!sameOrigin(request, env))
      return json({ error: "Origin rejected" }, 403);

    return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
  }

  if (path === "/api/me" && method === "GET") {
    return json({
      authenticated: await authenticated(request, env)
    });
  }

  if (path.startsWith("/api/uploads/")) {
    const authError = await requireCEO(request, env);
    if (authError) return authError;

    if (!env.DB || !storageConfigured(env))
      return json({
        error: "Database or Filebase configuration is missing"
      }, 503);
  }

  if (path === "/api/uploads/start" && method === "POST") {
    let b;
    try {
      b = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    const title = safeText(b.title, 160);
    const artist = safeText(b.artist, 120);
    const description = safeText(b.description, 1000);
    const category = String(b.category || "");
    const type = String(b.content_type || "").toLowerCase();
    const fileName = safeText(b.file_name, 200);
    const size = Number(b.file_size);

    if (!title || !["music", "movie", "video"].includes(category))
      return json({ error: "Add a title and valid category" }, 400);

    if (!ALLOWED_TYPES.has(type))
      return json({ error: "This file type is not on the allowed list" }, 415);

    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_SIZE)
      return json({ error: "File size exceeds the current upload limit" }, 400);

    if (category === "music" && !type.startsWith("audio/"))
      return json({ error: "Music must be an audio file" }, 400);

    if (category !== "music" && !type.startsWith("video/"))
      return json({ error: "Movies/videos must be video files" }, 400);

    const id = safeId();
    const key = safeKey(id, fileName);

    let client;
    let uploadId;

    try {
      // Keep client creation inside this try block so its errors are logged too.
      client = storage(env);

      const result = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: env.FILEBASE_BUCKET,
          Key: key,
          ContentType: type,
          CacheControl: "public, max-age=3600"
        })
      );

      uploadId = result.UploadId;

      if (!uploadId)
        throw new Error("Filebase did not return an upload ID");

      await env.DB.prepare(
        `INSERT INTO uploads
        (id,r2_upload_id,object_key,title,artist,description,
        category,content_type,file_size,allow_download)
        VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        id, uploadId, key, title, artist, description,
        category, type, size, b.allow_download ? 1 : 0
      ).run();

      return json({ id }, 201);
    } catch (error) {
      // Log diagnostic details in Cloudflare Observability. Never log credentials.
      console.error("UPLOAD_INIT_FAILED", {
        name: error?.name || "Error",
        message: error?.message || String(error),
        code: error?.Code || error?.code || "",
        statusCode: error?.$metadata?.httpStatusCode || "",
        requestId: error?.$metadata?.requestId || ""
      });

      if (uploadId && client) {
        try {
          await client.send(new AbortMultipartUploadCommand({
            Bucket: env.FILEBASE_BUCKET,
            Key: key,
            UploadId: uploadId
          }));
        } catch (cleanupError) {
          console.error("UPLOAD_CLEANUP_FAILED", {
            name: cleanupError?.name || "Error",
            message: cleanupError?.message || String(cleanupError),
            code: cleanupError?.Code || cleanupError?.code || ""
          });
        }
      }

      return json({
        error: "Could not initialize upload. Check Cloudflare logs for UPLOAD_INIT_FAILED."
      }, 500);
    }
  }

  const partMatch = path.match(
    /^\/api\/uploads\/([0-9a-f-]+)\/part$/i
  );

  if (partMatch && method === "PUT") {
    const id = partMatch[1];
    const partNumber = Number(url.searchParams.get("partNumber"));

    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000)
      return json({ error: "Invalid part number" }, 400);

    const upload = await env.DB.prepare(
      "SELECT r2_upload_id,object_key,file_size FROM uploads WHERE id=?"
    ).bind(id).first();

    if (!upload) return json({ error: "Upload not found" }, 404);

    const expectedParts = Math.ceil(upload.file_size / CHUNK_MAX);

    if (partNumber > expectedParts)
      return json({ error: "Part number exceeds expected upload size" }, 400);

    const data = await request.arrayBuffer();

    const expectedSize = Math.min(
      CHUNK_MAX,
      upload.file_size - (partNumber - 1) * CHUNK_MAX
    );

    if (data.byteLength !== expectedSize)
      return json({ error: "Invalid chunk size" }, 400);

    try {
      const result = await storage(env).send(
        new UploadPartCommand({
          Bucket: env.FILEBASE_BUCKET,
          Key: upload.object_key,
          UploadId: upload.r2_upload_id,
          PartNumber: partNumber,
          Body: new Uint8Array(data),
          ContentLength: data.byteLength
        })
      );

      if (!result.ETag)
        throw new Error("Missing ETag");

      return json({
        partNumber,
        etag: result.ETag
      });
    } catch (error) {
      console.error("UPLOAD_PART_FAILED", {
        name: error?.name || "Error",
        message: error?.message || String(error),
        code: error?.Code || error?.code || "",
        statusCode: error?.$metadata?.httpStatusCode || ""
      });

      return json({
        error: "Could not upload this part; retry it"
      }, 500);
    }
  }

  const completeMatch = path.match(
    /^\/api\/uploads\/([0-9a-f-]+)\/complete$/i
  );

  if (completeMatch && method === "POST") {
    const id = completeMatch[1];

    let b;
    try {
      b = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    const upload = await env.DB.prepare(
      "SELECT * FROM uploads WHERE id=?"
    ).bind(id).first();

    if (!upload) return json({ error: "Upload not found" }, 404);

    const expectedParts = Math.ceil(upload.file_size / CHUNK_MAX);

    if (!Array.isArray(b.parts) ||
      b.parts.length !== expectedParts ||
      b.parts.length > 10000)
      return json({ error: "Upload is missing one or more parts" }, 400);

    const parts = b.parts.map(p => ({
      PartNumber: Number(p.partNumber),
      ETag: String(p.etag || "")
    }));

    if (parts.some(p =>
      !Number.isInteger(p.PartNumber) ||
      p.PartNumber < 1 ||
      !p.ETag ||
      /[\r\n]/.test(p.ETag)
    )) return json({ error: "Invalid parts list" }, 400);

    if (new Set(parts.map(p => p.PartNumber)).size !== parts.length)
      return json({ error: "Duplicate upload parts" }, 400);

    parts.sort((a, b) => a.PartNumber - b.PartNumber);

    if (parts.some((p, i) => p.PartNumber !== i + 1))
      return json({ error: "Parts must be sequential" }, 400);

    try {
      await storage(env).send(
        new CompleteMultipartUploadCommand({
          Bucket: env.FILEBASE_BUCKET,
          Key: upload.object_key,
          UploadId: upload.r2_upload_id,
          MultipartUpload: { Parts: parts }
        })
      );

      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO media
          (id,title,artist,description,category,content_type,
          object_key,file_size,allow_download,published)
          VALUES (?,?,?,?,?,?,?,?,?,1)`
        ).bind(
          upload.id, upload.title, upload.artist, upload.description,
          upload.category, upload.content_type, upload.object_key,
          upload.file_size, upload.allow_download
        ),
        env.DB.prepare(
          "DELETE FROM uploads WHERE id=?"
        ).bind(id)
      ]);

      return json({ ok: true, id }, 201);
    } catch (error) {
      console.error("UPLOAD_COMPLETE_FAILED", {
        name: error?.name || "Error",
        message: error?.message || String(error),
        code: error?.Code || error?.code || "",
        statusCode: error?.$metadata?.httpStatusCode || ""
      });

      return json({
        error: "Could not complete upload. Check the parts and try again."
      }, 500);
    }
  }

  if (path.startsWith("/api/uploads/") && method === "DELETE") {
    const id = path.split("/")[3];

    const upload = await env.DB.prepare(
      "SELECT * FROM uploads WHERE id=?"
    ).bind(id).first();

    if (upload) {
      try {
        await storage(env).send(
          new AbortMultipartUploadCommand({
            Bucket: env.FILEBASE_BUCKET,
            Key: upload.object_key,
            UploadId: upload.r2_upload_id
          })
        );
      } catch (error) {
        console.error("UPLOAD_ABORT_FAILED", {
          name: error?.name || "Error",
          message: error?.message || String(error)
        });
      }

      await env.DB.prepare(
        "DELETE FROM uploads WHERE id=?"
      ).bind(id).run();
    }

    return json({ ok: true });
  }

  const mediaMatch = path.match(/^\/media\/([0-9a-f-]+)$/i);

  if (mediaMatch && method === "GET") {
    const item = await env.DB.prepare(
      "SELECT * FROM media WHERE id=? AND published=1"
    ).bind(mediaMatch[1]).first();

    if (!item) return json({ error: "Media not found" }, 404);

    const download = url.searchParams.has("download");

    if (download && !item.allow_download)
      return json({ error: "Downloads are disabled for this item" }, 403);

    let range = request.headers.get("Range");
    let rangeStart;
    let rangeEnd;

    if (range) {
      const m = range.match(/^bytes=(\d*)-(\d*)$/);

      if (!m || (!m[1] && !m[2])) return emptyRange(item.file_size);

      if (!m[1]) {
        const suffix = Number(m[2]);
        if (!Number.isInteger(suffix) || suffix <= 0)
          return emptyRange(item.file_size);

        rangeStart = Math.max(0, item.file_size - suffix);
        rangeEnd = item.file_size - 1;
      } else {
        rangeStart = Number(m[1]);
        rangeEnd = m[2] ? Number(m[2]) : item.file_size - 1;
        rangeEnd = Math.min(rangeEnd, item.file_size - 1);
      }

      if (!Number.isSafeInteger(rangeStart) ||
        !Number.isSafeInteger(rangeEnd) ||
        rangeStart >= item.file_size ||
        rangeEnd < rangeStart)
        return emptyRange(item.file_size);

      range = `bytes=${rangeStart}-${rangeEnd}`;
    }

    try {
      const result = await storage(env).send(
        new GetObjectCommand({
          Bucket: env.FILEBASE_BUCKET,
          Key: item.object_key,
          ...(range ? { Range: range } : {})
        })
      );

      if (!result.Body)
        return json({ error: "Media file missing" }, 404);

      const headers = new Headers();

      headers.set(
        "content-type",
        result.ContentType || item.content_type
      );

      headers.set("accept-ranges", "bytes");
      headers.set(
        "content-length",
        String(result.ContentLength ?? item.file_size)
      );

      headers.set(
        "content-disposition",
        contentDisposition(item.title, download)
      );

      headers.set("x-content-type-options", "nosniff");

      if (result.ETag) headers.set("etag", result.ETag);

      if (range) {
        headers.set(
          "content-range",
          result.ContentRange ||
          `bytes ${rangeStart}-${rangeEnd}/${item.file_size}`
        );

        return new Response(responseBody(result.Body), {
          status: 206,
          headers
        });
      }

      return new Response(responseBody(result.Body), {
        status: 200,
        headers
      });

    } catch (error) {
      console.error("MEDIA_RETRIEVAL_FAILED", {
        name: error?.name || "Error",
        message: error?.message || String(error),
        code: error?.Code || error?.code || "",
        statusCode: error?.$metadata?.httpStatusCode || ""
      });

      return json({ error: "Could not retrieve media" }, 500);
    }
  }

  if (path.startsWith("/api/"))
    return json({ error: "Not found" }, 404);

  if (env.ASSETS)
    return env.ASSETS.fetch(request);

  return new Response(
    "Ethan Vibes assets are not configured.",
    { status: 503 }
  );
}

export default { fetch: handle };
