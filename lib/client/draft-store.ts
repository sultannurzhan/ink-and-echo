export type TurnDraft = {
  key: string;
  text?: string;
  imageData?: string;
  updatedAt: number;
};

const DATABASE_NAME = "ink-and-echo-drafts";
const STORE_NAME = "drafts";
const FALLBACK_PREFIX = "ink-and-echo:draft:";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function saveTurnDraft(draft: TurnDraft) {
  try {
    await withStore("readwrite", (store) => store.put(draft));
    return true;
  } catch {
    try {
      localStorage.setItem(`${FALLBACK_PREFIX}${draft.key}`, JSON.stringify(draft));
      return true;
    } catch {
      return false;
    }
  }
}

export async function readTurnDraft(key: string): Promise<TurnDraft | null> {
  try {
    return (await withStore("readonly", (store) => store.get(key))) ?? null;
  } catch {
    try {
      const value = localStorage.getItem(`${FALLBACK_PREFIX}${key}`);
      return value ? (JSON.parse(value) as TurnDraft) : null;
    } catch {
      return null;
    }
  }
}

export async function deleteTurnDraft(key: string) {
  try {
    await withStore("readwrite", (store) => store.delete(key));
  } catch {
    // Fallback cleanup below still runs.
  }
  try {
    localStorage.removeItem(`${FALLBACK_PREFIX}${key}`);
  } catch {
    // Draft cleanup is best-effort and must not break turn submission.
  }
}

export function turnDraftKey(roomCode: string, playerId: string, turnSignature: string) {
  return `${roomCode}:${playerId}:${turnSignature}`;
}
