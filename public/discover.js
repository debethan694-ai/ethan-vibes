const $ = (s) => document.querySelector(s);
const grid = $("#mediaGrid");

let allMedia = [];
let activeFilter = "all";

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

function render() {
  const query = $("#search").value.trim().toLowerCase();

  const items = allMedia.filter(item =>
    (activeFilter === "all" || item.category === activeFilter) &&
    [item.title, item.artist, item.description, item.category]
      .join(" ")
      .toLowerCase()
      .includes(query)
  );

  $("#resultCount").textContent = `${items.length} item${items.length === 1 ? "" : "s"}`;

  if (!items.length) {
    grid.innerHTML = '<div class="empty">Nothing found yet. Check back for fresh vibes ✨</div>';
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
            <button class="small-btn fav-btn" data-fav="${escapeHtml(item.id)}">♡ Favorite</button>
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

async function loadMedia() {
  try {
    const response = await fetch("/api/media");
    if (!response.ok) throw new Error("Could not load content");

    allMedia = await response.json();
    render();
  } catch {
    grid.innerHTML = '<div class="empty">Content is temporarily unavailable. Please check back soon.</div>';
    $("#resultCount").textContent = "Unavailable";
  }
}

$("#search").addEventListener("input", render);

document.querySelectorAll("[data-filter]").forEach(button => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;

    document.querySelectorAll("[data-filter]").forEach(item => {
      item.classList.toggle("active", item === button);
    });

    render();
  });
});

loadMedia();
