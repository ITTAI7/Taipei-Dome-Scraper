import { Agent } from 'undici';
import { isCloudMode } from './IbonBrowser.js';

/**
 * 某些公司/機構的網路環境會透過 TLS 攔截代理（SSL Inspection）重新簽發
 * 外部售票網站的憑證，且重簽用的金鑰只有 1024-bit，導致 Node 內建 fetch
 * 在 TLS 交握階段就直接失敗（"CA certificate key too weak"），連 HTTP
 * 請求都送不出去。實測過這個攔截代理鎖定的網域不只一個、且會隨時間變動
 * （曾經只鎖 ibon 系網域，之後富邦、台鋼的網域也一起被鎖），所以不用寫死
 * 的網域清單，改成：正常 fetch 先試，只有在真的遇到這個特定錯誤訊號時才
 * 退而求其次改用放寬憑證驗證的 dispatcher 重試一次。
 *
 * 雲端主機（AI Studio 等）不會經過使用者這層公司代理，正常情況下不會遇到
 * 這個錯誤；為了不讓雲端正式環境的憑證驗證被不必要地放寬，這個機制只在
 * 非雲端模式（`!isCloudMode()`）下生效，雲端模式一律照舊走預設 fetch。
 */
const WEAK_CERT_ERROR_SIGNATURE = 'certificate key too weak';

let bypassAgent: Agent | null = null;
function getBypassAgent(): Agent {
  if (!bypassAgent) {
    bypassAgent = new Agent({ connect: { rejectUnauthorized: false } });
  }
  return bypassAgent;
}

function isWeakCertError(err: unknown): boolean {
  const cause = (err as any)?.cause;
  const msg = String(cause?.message ?? (err as any)?.message ?? '');
  return msg.includes(WEAK_CERT_ERROR_SIGNATURE);
}

export async function localSafeFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  if (isCloudMode()) {
    return fetch(url, init);
  }
  try {
    return await fetch(url, init);
  } catch (err) {
    if (!isWeakCertError(err)) throw err;
    return fetch(url, { ...init, dispatcher: getBypassAgent() } as RequestInit);
  }
}
