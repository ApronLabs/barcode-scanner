const storeGrid = document.getElementById('storeGrid');
const errorMsg = document.getElementById('errorMsg');

let lastStoreId = null;

async function loadStores() {
  const config = await window.api.getConfig();
  lastStoreId = config.lastStoreId;

  const result = await window.api.getStores();

  if (!result.success) {
    storeGrid.innerHTML = '';
    errorMsg.textContent = result.message;
    errorMsg.classList.add('visible');
    return;
  }

  const stores = result.stores;

  if (stores.length === 0) {
    storeGrid.innerHTML = '<div class="waiting">등록된 매장이 없습니다.</div>';
    return;
  }

  storeGrid.innerHTML = stores.map((store) => {
    const isLast = store.id === lastStoreId;
    return `
      <div class="store-card${isLast ? ' last-selected' : ''}" data-id="${store.id}" data-name="${store.name}">
        <div class="store-name">${store.name}</div>
        ${store.address ? `<div class="store-info">${store.address}</div>` : ''}
        ${isLast ? '<span class="last-tag">최근 사용</span>' : ''}
      </div>
    `;
  }).join('');

  // Attach click handlers
  document.querySelectorAll('.store-card').forEach((card) => {
    card.addEventListener('click', () => selectStore(card));
  });
}

async function selectStore(card) {
  const storeId = card.dataset.id;
  const storeName = card.dataset.name;

  await window.api.saveConfig({ lastStoreId: storeId, lastStoreName: storeName });

  // Store selected info in sessionStorage for scanner page
  sessionStorage.setItem('selectedStoreId', storeId);
  sessionStorage.setItem('selectedStoreName', storeName);

  window.api.navigate('scanner');
}

loadStores();
