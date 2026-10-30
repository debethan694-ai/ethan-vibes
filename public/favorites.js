const $ = (s) => document.querySelector(s);
const grid = $("#mediaGrid");

let allMedia = [];

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

function renderFavorites() {
  const favorites = JSON.parse(localStorage.getItem("ev-favs") || "[]");
  const items = allMedia.filter(item => favorites.includes(String(item.id)));

  $("#resultCount").textContent =
    `${items.length} saved item${items.length === 1 ? "" : "s"}`;

  if (!items.length) {
    grid.innerHTML =
      '<div class="empty">You have no favorites yet. Visit Music, Movies or Videos and tap ♡ Favorite.</div>';
    return;
  }

  grid.innerHTML = items.map(item => {
    const url = `/media/${encodeURIComponent(item.id)}`;

    const player = item.category === "music"
      ? `<audio controls preload="none" src="${url}"></audio>`
      : `<video controls preload="metadata" playsinline src="${url}"></video>`;

    const download = item.allow_download
      ? `<a class="small-btn primary" href="${url}?download=1">Download</a>`
      : "";

    return `
      <article class="media-card">
        <div class="cover ${escapeHtml(item.category)}">${player}</div>
        <div class="card-body">
          <h3>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(item.artist || item.category)}</p>
          <div class="card-actions">
            ${download}
            <button class="small-btn fav-btn" data-remove="${escapeHtml(item.id)}">♥ Remove</button>
          </div>
        </div>
      </article>
    `;
  }).join("");

  document.querySelectorAll("[data-remove]").forEach(button => {
    button.addEventListener("click", () => {
      const id = button.dataset.remove;
      const favorites = JSON.parse(localStorage.getItem("ev-favs") || "[]");
      localStorage.setItem(
        "ev-favs",
        JSON.stringify(favorites.filter(item => item !== id))
      );
      renderFavorites();
    });
  });
}

async function loadFavorites() {
  try {
    const response = await fetch("/api/media");
    if (!response.ok) throw new Error("Could not load media");

    allMedia = await response.json();
    renderFavorites();
  } catch {
    grid.innerHTML =
      '<div class="empty">Favorites are temporarily unavailable. Please try again later.</div>';
    $("#resultCount").textContent = "Unavailable";
  }
}

loadFavorites();
