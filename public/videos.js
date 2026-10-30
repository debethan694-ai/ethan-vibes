const $ = (s) => document.querySelector(s);
const grid = $("#mediaGrid");

let videos = [];

$("#year").textContent = new Date().getFullYear();

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}

function renderVideos() {
  const query = $("#search").value.trim().toLowerCase();

  const items = videos.filter(video =>
    [video.title, video.artist, video.description]
      .join(" ")
      .toLowerCase()
      .includes(query)
  );

  $("#resultCount").textContent =
    `${items.length} video${items.length === 1 ? "" : "s"}`;

  if (!items.length) {
    grid.innerHTML =
      '<div class="empty">No videos available yet. Check back soon ▶</div>';
    return;
  }

  grid.innerHTML = items.map(video => {
    const url = `/media/${encodeURIComponent(video.id)}`;
    const download = video.allow_download
      ? `<a class="small-btn primary" href="${url}?download=1">Download</a>`
      : "";

    return `
      <article class="media-card">
        <div class="cover video">
          <video controls preload="metadata" playsinline src="${url}"></video>
        </div>
        <div class="card-body">
          <h3>${escapeHtml(video.title)}</h3>
          <p>${escapeHtml(video.artist || "Video")}</p>
          <div class="card-actions">
            ${download}
            <button class="small-btn fav-btn" data-fav="${escapeHtml(video.id)}">
              ♡ Favorite
            </button>
          </div>
        </div>
      </article>
    `;
  }).join("");

  document.querySelectorAll("[data-fav]").forEach(button => {
    const key = "ev-favs";
    const id = button.dataset.fav;

    function updateButton() {
      const favorites = JSON.parse(localStorage.getItem(key) || "[]");
      button.textContent = favorites.includes(id) ? "♥ Saved" : "♡ Favorite";
    }

    updateButton();

    button.addEventListener("click", () => {
      const favorites = JSON.parse(localStorage.getItem(key) || "[]");
      const next = favorites.includes(id)
        ? favorites.filter(item => item !== id)
        : [...favorites, id];

      localStorage.setItem(key, JSON.stringify(next));
      updateButton();
    });
  });
}

async function loadVideos() {
  try {
    const response = await fetch("/api/media");

    if (!response.ok) throw new Error("Could not load videos");

    const data = await response.json();
    videos = data.filter(item => item.category === "video");
    renderVideos();

  } catch {
    grid.innerHTML =
      '<div class="empty">Videos are temporarily unavailable. Please check back soon.</div>';
    $("#resultCount").textContent = "Unavailable";
  }
}

$("#search").addEventListener("input", renderVideos);

loadVideos();
