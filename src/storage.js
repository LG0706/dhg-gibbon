const DATABASE_NAME = "gibbon-screening";
const DATABASE_VERSION = 1;
const STORE_KEYS = {
  batches: "batchId",
  results: "recordingKey",
  reviews: "candidate_id",
};

function memoryStorage(warning) {
  const stores = Object.fromEntries(Object.keys(STORE_KEYS).map((name) => [name, new Map()]));
  return {
    persistent: false,
    warning,
    async put(storeName, value) {
      const key = value[STORE_KEYS[storeName]];
      stores[storeName].set(key, structuredClone(value));
      return value;
    },
    async get(storeName, key) {
      return stores[storeName].has(key) ? structuredClone(stores[storeName].get(key)) : null;
    },
    async delete(storeName, key) {
      return stores[storeName].delete(key);
    },
    async getAll(storeName) {
      return Array.from(stores[storeName].values(), (value) => structuredClone(value));
    },
  };
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

function openDatabase(indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      for (const [storeName, keyPath] of Object.entries(STORE_KEYS)) {
        if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName, { keyPath });
      }
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    request.addEventListener("blocked", () => reject(new Error("IndexedDB 升级被其他标签页阻止")), { once: true });
  });
}

export async function createStorage(indexedDB = globalThis.indexedDB) {
  if (!indexedDB) return memoryStorage("浏览器不支持 IndexedDB，刷新后不会保留本次结果。");
  let database;
  try {
    database = await openDatabase(indexedDB);
  } catch (error) {
    return memoryStorage(`无法启用刷新持久化：${error.message}`);
  }

  return {
    persistent: true,
    warning: null,
    async put(storeName, value) {
      if (!STORE_KEYS[storeName]) throw new RangeError(`未知存储区: ${storeName}`);
      const transaction = database.transaction(storeName, "readwrite");
      const request = transaction.objectStore(storeName).put(value);
      await requestPromise(request);
      return value;
    },
    async get(storeName, key) {
      if (!STORE_KEYS[storeName]) throw new RangeError(`未知存储区: ${storeName}`);
      const transaction = database.transaction(storeName, "readonly");
      return requestPromise(transaction.objectStore(storeName).get(key)).then((value) => value ?? null);
    },
    async delete(storeName, key) {
      if (!STORE_KEYS[storeName]) throw new RangeError(`未知存储区: ${storeName}`);
      const transaction = database.transaction(storeName, "readwrite");
      await requestPromise(transaction.objectStore(storeName).delete(key));
    },
    async getAll(storeName) {
      if (!STORE_KEYS[storeName]) throw new RangeError(`未知存储区: ${storeName}`);
      const transaction = database.transaction(storeName, "readonly");
      return requestPromise(transaction.objectStore(storeName).getAll());
    },
  };
}

export { DATABASE_NAME, STORE_KEYS };
