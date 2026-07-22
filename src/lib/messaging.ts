// Promise-shaped chrome.runtime.sendMessage. Both the popup and the takeout
// page had near-identical wrappers; consolidating avoids the trap where one
// caller forgets to check chrome.runtime.lastError (which surfaces as an
// undefined response rather than a rejected promise).

export function sendMessage<T = unknown>(msg: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message ?? 'runtime.sendMessage error'));
        return;
      }
      resolve(r as T);
    });
  });
}
