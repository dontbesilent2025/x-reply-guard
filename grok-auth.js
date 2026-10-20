// X / Grok 订阅的 OAuth。公开客户端，没有 client_secret。
// 令牌打到 cli-chat-proxy.grok.com，消耗订阅里的 Grok 额度，不走 api.x.ai 的按量计费。

const GROK_OAUTH = {
  deviceUrl: "https://auth.x.ai/oauth2/device/code",
  tokenUrl: "https://auth.x.ai/oauth2/token",
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  scope: "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write",
  deviceGrant: "urn:ietf:params:oauth:grant-type:device_code"
};

const GROK_PROXY = {
  responsesUrl: "https://cli-chat-proxy.grok.com/v1/responses",
  headers: {
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-identifier": "grok-shell",
    "x-grok-client-version": "1.0.46"
  }
};

const GROK_REFRESH_SKEW_MS = 60 * 1000;
let grokRefreshTask = null;

function decodeBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return atob(padded);
}

function jwtExpMs(token) {
  try {
    const payload = JSON.parse(decodeBase64Url(String(token).split(".")[1] || ""));
    return Number(payload.exp) > 0 ? payload.exp * 1000 : 0;
  } catch (_error) {
    return 0;
  }
}

async function postForm(url, fields) {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: new URLSearchParams(fields)
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

async function readGrokAuth() {
  const { grokAuth } = await chrome.storage.local.get("grokAuth");
  if (!grokAuth?.accessToken || !grokAuth?.refreshToken) return null;
  return grokAuth;
}

async function writeGrokAuth(tokens) {
  const accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token;
  if (!accessToken || !refreshToken) {
    throw new Error("登录没有返回可用凭证，请重新登录");
  }
  const expiresAt = jwtExpMs(accessToken) || Date.now() + Number(tokens.expires_in || 0) * 1000;
  await chrome.storage.local.set({
    grokAuth: { accessToken, refreshToken, expiresAt }
  });
  return accessToken;
}

async function clearGrokAuth() {
  await chrome.storage.local.set({ grokAuth: null });
}

async function startGrokLogin() {
  const { ok, status, data } = await postForm(GROK_OAUTH.deviceUrl, {
    client_id: GROK_OAUTH.clientId,
    scope: GROK_OAUTH.scope
  });
  if (!ok || !data.device_code || !data.user_code) {
    const reason = data.error_description || data.error || "";
    throw new Error(
      status
        ? `Grok 登录启动失败（${status}）${reason ? "：" + String(reason).slice(0, 120) : ""}`
        : "连不上 auth.x.ai。请在 chrome://extensions 刷新本扩展，让它获得登录网址的权限。"
    );
  }
  return {
    ok: true,
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl: data.verification_uri_complete || data.verification_uri,
    interval: Math.max(1, Number(data.interval) || 5),
    expiresIn: Number(data.expires_in) || 600
  };
}

async function pollGrokLogin(deviceCode) {
  const { ok, data } = await postForm(GROK_OAUTH.tokenUrl, {
    grant_type: GROK_OAUTH.deviceGrant,
    client_id: GROK_OAUTH.clientId,
    device_code: deviceCode
  });
  if (ok) {
    await writeGrokAuth(data);
    return { ok: true, status: "success" };
  }
  if (data.error === "authorization_pending") return { ok: true, status: "pending" };
  if (data.error === "slow_down") return { ok: true, status: "slow_down" };
  if (data.error === "access_denied" || data.error === "authorization_denied") {
    return { ok: false, status: "error", error: "登录已取消" };
  }
  if (data.error === "expired_token") {
    return { ok: false, status: "error", error: "验证码过期，请重新登录" };
  }
  return { ok: false, status: "error", error: "Grok 登录失败" };
}

async function refreshGrok(auth) {
  const { ok, status, data } = await postForm(GROK_OAUTH.tokenUrl, {
    grant_type: "refresh_token",
    client_id: GROK_OAUTH.clientId,
    refresh_token: auth.refreshToken
  });
  if (!ok) {
    if (status === 400 || status === 401) {
      await clearGrokAuth();
      throw new Error("Grok 登录已失效，请在设置页重新登录");
    }
    if (status === 403) {
      throw new Error("当前订阅不能使用 Grok 接口");
    }
    throw new Error("Grok 登录刷新失败");
  }
  return writeGrokAuth(data);
}

async function getGrokAccessToken() {
  const auth = await readGrokAuth();
  if (!auth) throw new Error("请先在设置页用 X 订阅登录 Grok");
  if (jwtExpMs(auth.accessToken) - Date.now() > GROK_REFRESH_SKEW_MS) return auth.accessToken;
  if (!grokRefreshTask) {
    grokRefreshTask = refreshGrok(auth).finally(() => {
      grokRefreshTask = null;
    });
  }
  return grokRefreshTask;
}
