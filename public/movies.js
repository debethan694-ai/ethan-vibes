const $ = (s) => document.querySelector(s);
const grid = $("#mediaGrid");

let movies = [];

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

function renderMovies() {
  const query = $("#search").value.trim().toLowerCase();

  const items = movies.filter(movie =>
    [movie.title, movie.artist, movie.description]
      .join(" ")
      .toLowerCase()
      .includes(query)
  );

  $("#resultCount").textContent =
    `${items.length} movie${items.length === 1 ? "" : "s"}`;

  if (!items.length) {
    grid.innerHTML =
      '<div class="empty">No movies available yet. Check back soon 🎬</div>';
    return;
  }

  grid.innerHTML = items.map(movie => {
    const url = `/media/${encodeURIComponent(movie.id)}`;
    const download = movie.allow_download
      ? `<a class="small-btn primary" href="${url}?download=1">Download</a>`
      : "";

    return `
      <article class="media-card">
        <div class="cover movie">
          <video controls preload="metadata" playsinline src="${url}"></video>
        </div>
        <div class="card-body">
          <h3>${escapeHtml(movie.title)}</h3>
          <p>${escapeHtml(movie.artist || "Movie")}</p>
          <div class="card-actions">
            ${download}
            <button class="small-btn fav-btn" data-fav="${escapeHtml(movie.id)}">
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

async function loadMovies() {
  try {
    const response = await fetch("/api/media");

    if (!response.ok) throw new Error("Could not load movies");

    const data = await response.json();
    movies = data.filter(item => item.category === "movie");
    renderMovies();

  } catch {
    grid.innerHTML =
      '<div class="empty">Movies are temporarily unavailable. Please check back soon.</div>';
    $("#resultCount").textContent = "Unavailable";
  }
}

$("#search").addEventListener("input", renderMovies);

loadMovies();
