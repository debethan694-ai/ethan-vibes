const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const CHUNK_MAX = 8 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "audio/mpeg","audio/mp3","audio/mp4","audio/aac","audio/ogg","audio/opus","audio/wav","audio/x-wav","audio/flac",
  "video/mp4","video/webm","video/quicktime","video/x-matroska","video/mpeg"
]);

function json(data, status=200, headers={}) {
  return new Response(JSON.stringify(data), {status, headers:{...JSON_HEADERS,...headers}});
}
function b64url(bytes) { let s=""; for(const b of new Uint8Array(bytes)) s+=String.fromCharCode(b); return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return b64url(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(text)));
}
async function sessionToken(env) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({role:"ceo",exp:Date.now()+8*60*60*1000})));
  return `${payload}.${await hmac(env.SESSION_SECRET,payload)}`;
}
async function authenticated(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)ev_session=([^;]+)/);
  if(!match || !env.SESSION_SECRET) return false;
  const [payload, signature] = match[1].split(".");
  if(!payload || !signature || signature !== await hmac(env.SESSION_SECRET,payload)) return false;
  try {
    const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0))));
    return data.role === "ceo" && data.exp > Date.now();
  } catch { return false; }
}
function cookie(value, maxAge) {
  return `ev_session=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}
function safeText(value, max=1000) { return String(value ?? "").trim().slice(0,max); }
function safeId() { return crypto.randomUUID(); }
function safeKey(id, fileName) {
  const ext = (fileName.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g,"").slice(0,10) || "bin";
  return `media/${id}.${ext}`;
}
function sameOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // SameSite=Strict cookie remains the primary browser CSRF barrier.
  return origin === new URL(request.url).origin && (!env.SITE_ORIGIN || origin === env.SITE_ORIGIN);
}
async function requireCEO(request, env) {
  if (!await authenticated(request,env)) return json({error:"CEO sign-in required"},401);
  if (!sameOrigin(request,env)) return json({error:"Origin rejected"},403);
  return null;
}
function contentDisposition(name, attachment=false) {
  const clean = String(name || "media").replace(/[\r\n"\\]/g,"_").slice(0,150);
  return `${attachment?"attachment":"inline"}; filename="${clean}"`;
}
async function publicMedia(env) {
  const {results=[]} = await env.DB.prepare(
    "SELECT id,title,artist,description,category,content_type,file_size,allow_download,created_at FROM media WHERE published=1 ORDER BY created_at DESC LIMIT 300"
  ).all();
  return results.map(m=>({...m,allow_download:!!m.allow_download}));
}
async function handle(request, env) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if(path === "/api/health" && method==="GET") return json({ok:true,configured:!!(env.DB&&env.MEDIA&&env.CEO_PASSWORD&&env.SESSION_SECRET)});
  if(path === "/api/media" && method==="GET") {
    try { return json(await publicMedia(env),200,{"cache-control":"public, max-age=60"}); }
    catch { return json({error:"Database is not configured yet"},503); }
  }
  if(path === "/api/login" && method==="POST") {
    if(!sameOrigin(request,env)) return json({error:"Origin rejected"},403);
    if(!env.CEO_PASSWORD || !env.SESSION_SECRET) return json({error:"CEO login is not configured"},503);
    let body; try { body=await request.json(); } catch { return json({error:"Invalid request"},400); }
    const password = String(body.password || "");
    if(password.length < 12 || password !== env.CEO_PASSWORD)
      return json({error:"Incorrect password"},401);
    const token=await sessionToken(env);
    return json({authenticated:true},200,{"set-cookie":cookie(token,8*60*60),"cache-control":"no-store"});
  }
  if(path === "/api/logout" && method==="POST") {
    return json({ok:true},200,{"set-cookie":cookie("",0)});
  }
  if(path === "/api/me" && method==="GET") return json({authenticated:await authenticated(request,env)});
  if(path.startsWith("/api/uploads/") || path==="/api/uploads/start") {
    const authError=await requireCEO(request,env); if(authError) return authError;
    if(!env.DB || !env.MEDIA) return json({error:"Database or R2 bucket binding is missing"},503);
  }
  if(path === "/api/uploads/start" && method==="POST") {
    let b; try { b=await request.json(); } catch { return json({error:"Invalid JSON"},400); }
    const title=safeText(b.title,160), artist=safeText(b.artist,120), description=safeText(b.description,1000);
    const category=String(b.category||"");
    const type=String(b.content_type||"").toLowerCase();
    const fileName=safeText(b.file_name,200);
    const size=Number(b.file_size);
    if(!title || !["music","movie","video"].includes(category)) return json({error:"Add a title and valid category"},400);
    if(!ALLOWED_TYPES.has(type)) return json({error:"This file type is not on the allowed list"},415);
    if(!Number.isSafeInteger(size) || size<=0 || size>5*1024**4) return json({error:"Invalid file size"},400);
    if(category==="music" && !type.startsWith("audio/")) return json({error:"Music must be an audio file"},400);
    if(category!=="music" && !type.startsWith("video/")) return json({error:"Movies/videos must be video files"},400);
    const id=safeId(), key=safeKey(id,fileName);
    try {
      const mp=await env.MEDIA.createMultipartUpload(key,{httpMetadata:{contentType:type,cacheControl:"public, max-age=3600"}});
      await env.DB.prepare("INSERT INTO uploads (id,r2_upload_id,object_key,title,artist,description,category,content_type,file_size,allow_download) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(id,mp.uploadId,key,title,artist,description,category,type,size,b.allow_download?1:0).run();
      return json({id},201);
    } catch { return json({error:"Could not initialize upload. Check R2/D1 setup."},500); }
  }
  const partMatch=path.match(/^\/api\/uploads\/([0-9a-f-]+)\/part$/i);
  if(partMatch && method==="PUT") {
    const id=partMatch[1], partNumber=Number(url.searchParams.get("partNumber"));
    if(!Number.isInteger(partNumber)||partNumber<1||partNumber>10000) return json({error:"Invalid part number"},400);
    const upload=await env.DB.prepare("SELECT r2_upload_id,object_key,file_size FROM uploads WHERE id=?").bind(id).first();
    if(!upload) return json({error:"Upload not found"},404);
    const len=Number(request.headers.get("Content-Length")||0);
    if(len>CHUNK_MAX) return json({error:"Each part must be 8 MiB or smaller"},413);
    const data=await request.arrayBuffer();
    if(data.byteLength===0 || data.byteLength>CHUNK_MAX) return json({error:"Invalid chunk size"},400);
    try {
      const mp=env.MEDIA.resumeMultipartUpload(upload.object_key,upload.r2_upload_id);
      const result=await mp.uploadPart(partNumber,data);
      return json({partNumber,etag:result.etag});
    } catch { return json({error:"Could not upload this part; retry it"},500); }
  }
  const completeMatch=path.match(/^\/api\/uploads\/([0-9a-f-]+)\/complete$/i);
  if(completeMatch && method==="POST") {
    const id=completeMatch[1]; let b; try {b=await request.json();} catch{return json({error:"Invalid JSON"},400);}
    const upload=await env.DB.prepare("SELECT * FROM uploads WHERE id=?").bind(id).first();
    if(!upload) return json({error:"Upload not found"},404);
    if(!Array.isArray(b.parts)||!b.parts.length||b.parts.length>10000) return json({error:"Missing multipart parts"},400);
    const parts=b.parts.map(p=>({partNumber:Number(p.partNumber),etag:String(p.etag||"")}));
    if(parts.some(p=>!Number.isInteger(p.partNumber)||p.partNumber<1||!p.etag) || new Set(parts.map(p=>p.partNumber)).size!==parts.length)
      return json({error:"Invalid parts list"},400);
    parts.sort((a,b)=>a.partNumber-b.partNumber);
    if(parts.some((p,i)=>p.partNumber!==i+1)) return json({error:"Parts must be sequential"},400);
    try {
      const mp=env.MEDIA.resumeMultipartUpload(upload.object_key,upload.r2_upload_id);
      await mp.complete(parts);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO media (id,title,artist,description,category,content_type,object_key,file_size,allow_download,published) VALUES (?,?,?,?,?,?,?,?,?,1)")
          .bind(upload.id,upload.title,upload.artist,upload.description,upload.category,upload.content_type,upload.object_key,upload.file_size,upload.allow_download),
        env.DB.prepare("DELETE FROM uploads WHERE id=?").bind(id)
      ]);
      return json({ok:true,id},201);
    } catch { return json({error:"Could not complete upload. Check parts and try again."},500); }
  }
  if(path.startsWith("/api/uploads/") && method==="DELETE") {
    const id=path.split("/")[3];
    const u=await env.DB.prepare("SELECT * FROM uploads WHERE id=?").bind(id).first();
    if(u) { try {await env.MEDIA.resumeMultipartUpload(u.object_key,u.r2_upload_id).abort();}catch{} await env.DB.prepare("DELETE FROM uploads WHERE id=?").bind(id).run(); }
    return json({ok:true});
  }
  const mediaMatch=path.match(/^\/media\/([0-9a-f-]+)$/i);
  if(mediaMatch && method==="GET") {
    const item=await env.DB.prepare("SELECT * FROM media WHERE id=? AND published=1").bind(mediaMatch[1]).first();
    if(!item) return json({error:"Media not found"},404);
    if(url.searchParams.has("download") && !item.allow_download) return json({error:"Downloads are disabled for this item"},403);
    let object;
    const range=request.headers.get("Range");
    try {
      if(range) {
        const m=range.match(/^bytes=(\d*)-(\d*)$/);
        if(!m || (!m[1]&&!m[2])) return new Response(null,{status:416});
        let start,end;
        if(!m[1]) { const suffix=Number(m[2]); start=Math.max(0,item.file_size-suffix); end=item.file_size-1; }
        else { start=Number(m[1]); end=m[2]?Math.min(Number(m[2]),item.file_size-1):item.file_size-1; }
        if(start>=item.file_size||end<start) return new Response(null,{status:416,headers:{"content-range":`bytes */${item.file_size}`}});
        object=await env.MEDIA.get(item.object_key,{range:{offset:start,length:end-start+1}});
        if(!object) return json({error:"Media file missing"},404);
        const headers=new Headers();
        object.writeHttpMetadata(headers);
        headers.set("accept-ranges","bytes"); headers.set("content-length",String(end-start+1));
        headers.set("content-range",`bytes ${start}-${end}/${item.file_size}`);
        headers.set("content-disposition",contentDisposition(item.title, url.searchParams.has("download")));
        headers.set("x-content-type-options","nosniff");
        return new Response(object.body,{status:206,headers});
      }
      object=await env.MEDIA.get(item.object_key);
      if(!object) return json({error:"Media file missing"},404);
      const headers=new Headers(); object.writeHttpMetadata(headers);
      headers.set("content-length",String(object.size)); headers.set("accept-ranges","bytes");
      headers.set("content-disposition",contentDisposition(item.title,url.searchParams.has("download")));
      headers.set("x-content-type-options","nosniff");
      return new Response(object.body,{headers});
    } catch { return json({error:"Could not retrieve media"},500); }
  }
  if(path.startsWith("/api/")) return json({error:"Not found"},404);
  if(env.ASSETS) return env.ASSETS.fetch(request);
  return new Response("Ethan Vibes assets are not configured.",{status:503});
}
export default { fetch: handle };
