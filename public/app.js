const $ = (s) => document.querySelector(s);
const grid = $("#mediaGrid");
let allMedia = [];
let activeFilter = "all";
let loggedIn = false;
$("#year").textContent = new Date().getFullYear();

function escapeHtml(s="") { return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function iconFor(type) { return type === "music" ? "♫" : type === "movie" ? "🎬" : "▶"; }
function render() {
  const q = $("#search").value.trim().toLowerCase();
  const items = allMedia.filter(m => (activeFilter === "all" || m.category === activeFilter) &&
    [m.title,m.artist,m.description,m.category].join(" ").toLowerCase().includes(q));
  $("#resultCount").textContent = `${items.length} item${items.length===1?"":"s"}`;
  if (!items.length) { grid.innerHTML = '<div class="empty">No uploads yet. Check back soon for fresh vibes ✨</div>'; return; }
  grid.innerHTML = items.map(m => {
    const mediaUrl = `/media/${encodeURIComponent(m.id)}`;
    const player = m.category === "music"
      ? `<audio controls preload="none" src="${mediaUrl}"></audio>`
      : `<video controls preload="metadata" playsinline src="${mediaUrl}"></video>`;
    const download = m.allow_download ? `<a class="small-btn primary" href="${mediaUrl}?download=1">Download</a>` : "";
    return `<article class="media-card"><div class="cover ${escapeHtml(m.category)}">${player}</div><div class="card-body"><h3>${escapeHtml(m.title)}</h3><p>${escapeHtml(m.artist || m.category.toUpperCase())}</p><div class="card-actions">${download}<button class="small-btn fav-btn" data-fav="${escapeHtml(m.id)}">♡ Favorite</button></div></div></article>`;
  }).join("");
  document.querySelectorAll("[data-fav]").forEach(btn => {
    const key = "ev-favs"; const favs = JSON.parse(localStorage.getItem(key) || "[]");
    if (favs.includes(btn.dataset.fav)) btn.textContent = "♥ Saved";
    btn.addEventListener("click", () => {
      const current = JSON.parse(localStorage.getItem(key) || "[]");
      const next = current.includes(btn.dataset.fav) ? current.filter(x=>x!==btn.dataset.fav) : [...current,btn.dataset.fav];
      localStorage.setItem(key, JSON.stringify(next)); btn.textContent = next.includes(btn.dataset.fav) ? "♥ Saved" : "♡ Favorite";
    });
  });
}
async function loadMedia() {
  try {
    const r = await fetch("/api/media");
    if (!r.ok) throw new Error("Could not load catalogue");
    allMedia = await r.json(); render();
  } catch { grid.innerHTML = '<div class="empty">The website is ready for setup. Connect the database and media bucket to publish your first upload.</div>'; $("#resultCount").textContent = "Setup needed"; }
}
document.querySelectorAll("[data-filter]").forEach(btn => btn.addEventListener("click", () => {
  activeFilter = btn.dataset.filter;
  document.querySelectorAll("[data-filter]").forEach(b => b.classList.toggle("active", b === btn));
  render();
}));
$("#search").addEventListener("input", render);
$("#adminToggle").addEventListener("click", async () => {
  $("#adminPanel").classList.toggle("hidden");
  $("#adminPanel").scrollIntoView({behavior:"smooth",block:"start"});
  await checkSession();
});
$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault(); $("#loginMessage").textContent = "Signing in…";
  try {
    const r = await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:$("#ceoPassword").value})});
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Sign-in failed");
    $("#ceoPassword").value = ""; $("#loginMessage").textContent = "Welcome, CEO.";
    await checkSession();
  } catch(err) { $("#loginMessage").textContent = err.message; }
});
async function checkSession() {
  try { const r = await fetch("/api/me"); loggedIn = r.ok && (await r.json()).authenticated; } catch { loggedIn=false; }
  $("#loginForm").classList.toggle("hidden",loggedIn);
  $("#uploadForm").classList.toggle("hidden",!loggedIn);
  $("#logoutBtn").classList.toggle("hidden",!loggedIn);
  $("#adminToggle").textContent = loggedIn ? "CEO studio ✓" : "CEO login";
}
$("#logoutBtn").addEventListener("click", async () => {
  await fetch("/api/logout",{method:"POST"}); loggedIn=false; await checkSession();
});
$("#uploadForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!loggedIn) { $("#uploadMessage").textContent="Please sign in again."; return; }
  const form = e.currentTarget, file = form.elements.file.files[0];
  if (!file) return;
  const category=form.elements.category.value;
  if ((category==="music" && !file.type.startsWith("audio/")) || (category!=="music" && !file.type.startsWith("video/"))) {
    $("#uploadMessage").textContent="Choose an audio file for Music, or a video file for Movie/Video."; return;
  }
  $("#uploadMessage").textContent="Preparing upload…"; $("#uploadProgress").style.width="0%";
  try {
    const payload={title:form.elements.title.value,artist:form.elements.artist.value,description:form.elements.description.value,category,allow_download:form.elements.allow_download.value==="1",file_name:file.name,content_type:file.type||"application/octet-stream",file_size:file.size};
    let r=await fetch("/api/uploads/start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    let data=await r.json(); if(!r.ok) throw new Error(data.error||"Could not start upload");
    const chunkSize=8*1024*1024, parts=[];
    for(let offset=0,part=1;offset<file.size;offset+=chunkSize,part++){
      const chunk=file.slice(offset,Math.min(offset+chunkSize,file.size));
      $("#uploadMessage").textContent=`Uploading part ${part} of ${Math.ceil(file.size/chunkSize)}…`;
      let tries=0, partData;
      while(tries<3){
        try{
          r=await fetch(`/api/uploads/${encodeURIComponent(data.id)}/part?partNumber=${part}`,{method:"PUT",headers:{"Content-Type":"application/octet-stream"},body:chunk});
          partData=await r.json(); if(!r.ok) throw new Error(partData.error||"Part upload failed"); break;
        }catch(err){tries++;if(tries>=3)throw err;}
      }
      parts.push({partNumber:part,etag:partData.etag});
      $("#uploadProgress").style.width=`${Math.min(99,Math.round((offset+chunk.size)/file.size*100))}%`;
    }
    r=await fetch(`/api/uploads/${encodeURIComponent(data.id)}/complete`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({parts})});
    data=await r.json(); if(!r.ok) throw new Error(data.error||"Could not complete upload");
    $("#uploadProgress").style.width="100%"; $("#uploadMessage").textContent="Published successfully!";
    form.reset(); await loadMedia();
  }catch(err){$("#uploadMessage").textContent=`Upload stopped: ${err.message}. Keep this page open and try again; a failed upload may need cleanup.`;}
});
loadMedia();
  
