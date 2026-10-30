const $ = (s) => document.querySelector(s);
const grid = $("#mediaGrid");

let music = [];

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

function renderMusic() {
  const query = $("#search").value.trim().toLowerCase();

  const items = music.filter(song =>
    [song.title, song.artist, song.description]
      .join(" ")
      .toLowerCase()
      .includes(query)
  );

  $("#resultCount").textContent =
    `${items.length} song${items.length === 1 ? "" : "s"}`;

  if (!items.length) {
    grid.innerHTML =
      '<div class="empty">No music found yet. Check back for fresh vibes ✨</div>';
    return;
  }

  grid.innerHTML = items.map(song => {
    const url = `/media/${encodeURIComponent(song.id)}`;
    const download = song.allow_download
      ? `<a class="small-btn primary" href="${url}?download=1">Download</a>`
      : "";

    return `
      <article class="media-card">
        <div class="cover music">
          <audio controls preload="none" src="${url}"></audio>
        </div>
        <div class="card-body">
          <h3>${escapeHtml(song.title)}</h3>
          <p>${escapeHtml(song.artist || "Music")}</p>
          <div class="card-actions">
            ${download}
            <button class="small-btn fav-btn" data-fav="${escapeHtml(song.id)}">
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

async function loadMusic() {
  try {
    const response = await fetch("/api/media");

    if (!response.ok) {
      throw new Error("Could not load music");
    }

    const data = await response.json();
    music = data.filter(item => item.category === "music");
    renderMusic();

  } catch {
    grid.innerHTML =
      '<div class="empty">Music is temporarily unavailable. Please check back soon.</div>';
    $("#resultCount").textContent = "Unavailable";
  }
}

$("#search").addEventListener("input", renderMusic);

loadMusic();
