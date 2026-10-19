(() => {
  if (window.__xReplyCleaner) return;
  window.__xReplyCleaner = true;

  const BUTTON_ATTRIBUTE = "data-x-hide-block-button";
  const TOAST_ID = "x-hide-block-toast";
  const STATUS_ID_PATTERN = /\/status\/(\d+)/;
  const HIDE_LABELS = ["隐藏回复", "隐藏此回复", "Hide reply"];
  const BLOCK_WORDS = ["屏蔽", "封锁", "Block"];
  let operationInProgress = false;

  const sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

  function normalize(value) {
    return (value || "").replace(/\s+/g, "").trim();
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  async function waitFor(find, timeout = 5000, interval = 100) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = find();
      if (result) return result;
      await sleep(interval);
    }
    return null;
  }

  function currentMainStatusId() {
    return location.pathname.match(STATUS_ID_PATTERN)?.[1] || null;
  }

  function isSupportedPage() {
    return Boolean(
      currentMainStatusId() ||
      location.pathname === "/notifications" ||
      location.pathname.startsWith("/notifications/")
    );
  }

  function articlePermalink(article) {
    const time = article.querySelector("time");
    return time?.closest('a[href*="/status/"]')?.getAttribute("href") || "";
  }

  function articleAuthorHandle(article) {
    const permalink = articlePermalink(article);
    return permalink.match(/^\/([^/]+)\/status\/\d+/)?.[1]?.toLowerCase() || null;
  }

  function loggedInHandle() {
    const profileLink = document.querySelector(
      'a[data-testid="AppTabBar_Profile_Link"][href]'
    );
    const profileMatch = profileLink
      ?.getAttribute("href")
      ?.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    if (profileMatch) return profileMatch[1].toLowerCase();

    const accountSwitcher = document.querySelector(
      '[data-testid="SideNav_AccountSwitcher_Button"]'
    );
    if (!accountSwitcher) return null;

    const switcherLink = [...accountSwitcher.querySelectorAll("a[href]")].find((link) => {
      return /^\/[A-Za-z0-9_]{1,15}\/?$/.test(link.getAttribute("href") || "");
    });
    const linkMatch = switcherLink
      ?.getAttribute("href")
      ?.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    if (linkMatch) return linkMatch[1].toLowerCase();

    return accountSwitcher.innerText.match(/@([A-Za-z0-9_]{1,15})/)?.[1]?.toLowerCase() || null;
  }

  function isOwnArticle(article, ownHandle) {
    const authorHandle = articleAuthorHandle(article);
    return Boolean(authorHandle && ownHandle && authorHandle === ownHandle);
  }

  function findActionGroup(article) {
    return [...article.querySelectorAll('[role="group"]')].find((group) => {
      return (
        group.querySelector('[data-testid="reply"]') &&
        group.querySelector('[data-testid="like"], [data-testid="unlike"]')
      );
    });
  }

  function showToast(message, type = "success") {
    document.getElementById(TOAST_ID)?.remove();
    const toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.textContent = message;
    Object.assign(toast.style, {
      position: "fixed",
      left: "50%",
      bottom: "28px",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      padding: "10px 16px",
      borderRadius: "999px",
      background: type === "success" ? "#0f1419" : "#e0245e",
      color: "#fff",
      font: "600 14px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      boxShadow: "0 6px 24px rgba(0,0,0,.24)",
      pointerEvents: "none"
    });
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
  }

  function visibleMenuItems() {
    return [...document.querySelectorAll('[role="menuitem"]')].filter(isVisible);
  }

  function findHideReplyMenuItem() {
    return visibleMenuItems().find((item) => {
      const text = normalize(item.innerText || item.getAttribute("aria-label"));
      return HIDE_LABELS.some((label) => text.includes(normalize(label)));
    });
  }

  function findBlockAccountMenuItem() {
    return visibleMenuItems().find((item) => {
      if (item.matches('[data-testid="block"]') || item.querySelector('[data-testid="block"]')) {
        return true;
      }
      const text = normalize(item.innerText || item.getAttribute("aria-label"));
      return /^(屏蔽|封锁)@/.test(text) || /^Block@/i.test(text);
    });
  }

  function visibleDialogs() {
    return [
      ...document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [data-testid="confirmationSheetDialog"]'
      )
    ].filter(isVisible);
  }

  function dialogIncludes(dialog, words) {
    const text = normalize(dialog.innerText || dialog.getAttribute("aria-label"));
    return words.some((word) => text.includes(normalize(word)));
  }

  function visibleButtons(root) {
    return [...root.querySelectorAll('button, [role="button"]')].filter(isVisible);
  }

  function findConfirmButton(dialog, exactLabels) {
    const testIdButton = dialog.querySelector('[data-testid="confirmationSheetConfirm"]');
    if (testIdButton && isVisible(testIdButton)) return testIdButton;

    return visibleButtons(dialog).find((button) => {
      const text = normalize(button.innerText || button.getAttribute("aria-label"));
      return exactLabels.some((label) => text === normalize(label));
    });
  }

  function findHideDialog() {
    return visibleDialogs().find((dialog) => {
      return dialogIncludes(dialog, ["隐藏回复", "Hide reply"]);
    });
  }

  function findBlockDialog() {
    return visibleDialogs().find((dialog) => {
      return (
        dialogIncludes(dialog, BLOCK_WORDS) &&
        Boolean(findConfirmButton(dialog, ["屏蔽", "封锁", "Block"]))
      );
    });
  }

  async function closeOpenMenu() {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })
    );
    await sleep(100);
  }

  async function confirmBlockAccount() {
    const blockDialog = await waitFor(findBlockDialog, 6000);
    if (!blockDialog) throw new Error("没有出现屏蔽账号确认框");

    const confirmBlock = findConfirmButton(blockDialog, ["屏蔽", "封锁", "Block"]);
    if (!confirmBlock) throw new Error("找不到屏蔽账号的确认按钮");
    confirmBlock.click();
    await waitFor(() => !isVisible(blockDialog), 4000);
  }

  // X 简体中文把 Mute 叫作「隐藏 @用户」，繁体为「靜音」。
  function findMuteAccountMenuItem(handle) {
    return visibleMenuItems().find((item) => {
      if (item.matches('[data-testid="mute"]') || item.querySelector('[data-testid="mute"]')) {
        return true;
      }
      const text = normalize(item.innerText || item.getAttribute("aria-label")).toLowerCase();
      if (/回复|對話|对话|conversation|reply/.test(text)) return false;
      const mentionsAuthor = handle ? text.includes(`@${handle}`) : text.includes("@");
      return mentionsAuthor && /隐藏|靜音|静音|mute/.test(text);
    });
  }

  function menuItemTexts() {
    return visibleMenuItems()
      .map((item) => (item.innerText || item.getAttribute("aria-label") || "").trim())
      .filter(Boolean)
      .join("／");
  }

  function findMuteDialog() {
    return visibleDialogs().find((dialog) => {
      return (
        dialogIncludes(dialog, ["隐藏", "靜音", "静音", "Mute"]) &&
        Boolean(findConfirmButton(dialog, ["隐藏", "靜音", "静音", "Mute"]))
      );
    });
  }

  // 隐藏通常直接生效；个别版本会弹确认框。
  async function confirmMuteIfAsked() {
    const dialog = await waitFor(findMuteDialog, 1200);
    if (!dialog) return;
    findConfirmButton(dialog, ["隐藏", "靜音", "静音", "Mute"])?.click();
    await waitFor(() => !isVisible(dialog), 3000);
  }

  async function dismissDialog(dialog) {
    const cancel = visibleButtons(dialog).find((button) => {
      const text = normalize(button.innerText || button.getAttribute("aria-label"));
      return ["取消", "Cancel"].includes(text);
    });
    if (cancel) cancel.click();
    else await closeOpenMenu();
    await waitFor(() => !isVisible(dialog), 3000);
  }

  async function openArticleMenu(article) {
    const caret = article.isConnected && article.querySelector('[data-testid="caret"]');
    if (!caret || !isVisible(caret)) return false;
    caret.click();
    const menuReady = await waitFor(() => visibleMenuItems().length > 0, 4000);
    if (!menuReady) await closeOpenMenu();
    return Boolean(menuReady);
  }

  // 在已打开的菜单里对发布者执行隐藏或屏蔽。
  async function actOnAuthorFromMenu(action, handle) {
    if (action === "block") {
      const blockItem = findBlockAccountMenuItem();
      if (!blockItem) {
        const items = menuItemTexts();
        await closeOpenMenu();
        throw new Error(`菜单中没有找到「屏蔽」。菜单项：${items || "空"}`);
      }
      blockItem.click();
      await confirmBlockAccount();
      return;
    }

    const muteItem = findMuteAccountMenuItem(handle);
    if (!muteItem) {
      const items = menuItemTexts();
      await closeOpenMenu();
      throw new Error(`菜单中没有找到「隐藏 @用户」。菜单项：${items || "空"}`);
    }
    muteItem.click();
    await confirmMuteIfAsked();
  }

  const ACTION_TEXT = {
    mute: { done: "已隐藏", person: "隐藏此人" },
    block: { done: "已拉黑", person: "屏蔽账号" }
  };

  // action：mute 为隐藏此人，block 为拉黑。先隐藏回复，再处理发布者。
  async function hideReplyThenAct(article, button, action) {
    if (operationInProgress) {
      showToast("上一项仍在处理中", "error");
      return;
    }

    operationInProgress = true;
    const group = button.parentElement;
    const buttons = [...(group?.querySelectorAll("button") || [button])];
    const originalText = button.textContent;
    buttons.forEach((item) => (item.disabled = true));
    button.textContent = "处理中…";
    let replyHidden = false;
    const handle = articleAuthorHandle(article);

    try {
      if (!(await openArticleMenu(article))) {
        throw new Error("找不到这条回复的更多菜单");
      }

      // 「隐藏」只静音发布者，不隐藏回复，避免触发「要屏蔽吗」的弹窗。
      if (action === "mute") {
        await actOnAuthorFromMenu("mute", handle);
        if (button.isConnected) button.textContent = ACTION_TEXT.mute.done;
        showToast("已隐藏此人");
        return;
      }

      const hideItem = findHideReplyMenuItem();
      if (!hideItem) {
        // 别人的推文下面没有「隐藏回复」权限，直接处理发布者。
        await actOnAuthorFromMenu(action, handle);
        if (button.isConnected) button.textContent = ACTION_TEXT[action].done;
        showToast(`此处不能隐藏回复，已${ACTION_TEXT[action].person}`);
        return;
      }

      hideItem.click();

      // 某些版本会先显示「隐藏回复」确认框，另一些会直接执行。
      const firstDialog = await waitFor(() => findHideDialog() || findBlockDialog(), 3500);
      if (firstDialog && firstDialog === findHideDialog()) {
        const confirmHide = findConfirmButton(firstDialog, ["隐藏", "确认", "Hide"]);
        if (!confirmHide) throw new Error("找不到隐藏回复的确认按钮");
        confirmHide.click();
        await sleep(250);
      }
      replyHidden = true;

      // 隐藏回复后 X 通常会询问是否屏蔽发布者。
      const blockPrompt = await waitFor(findBlockDialog, 3500);
      if (action === "block" && blockPrompt) {
        await confirmBlockAccount();
      } else {
        if (blockPrompt) await dismissDialog(blockPrompt);
        if (!(await openArticleMenu(article))) {
          throw new Error("回复已从页面消失，找不到它的菜单");
        }
        await actOnAuthorFromMenu(action, handle);
      }

      if (button.isConnected) button.textContent = ACTION_TEXT[action].done;
      showToast(`已隐藏回复并${ACTION_TEXT[action].person}`);
    } catch (error) {
      const message = error.message || "操作未完成";
      showToast(
        replyHidden ? `回复已隐藏，但没能${ACTION_TEXT[action].person}：${message}` : message,
        "error"
      );
      if (button.isConnected) button.textContent = originalText;
      buttons.forEach((item) => (item.disabled = false));
    } finally {
      operationInProgress = false;
    }
  }

  function createActionButton(article, action) {
    const button = document.createElement("button");
    button.type = "button";
    const label = action === "block" ? "拉黑" : "隐藏";
    const hover =
      action === "block"
        ? { color: "rgb(244, 33, 46)", background: "rgba(244, 33, 46, .1)" }
        : { color: "rgb(29, 155, 240)", background: "rgba(29, 155, 240, .1)" };
    button.textContent = label;
    button.title =
      action === "block"
        ? "先隐藏这条回复，再屏蔽发布者"
        : "隐藏（静音）发布者，不隐藏这条回复";
    button.setAttribute("aria-label", button.title);
    Object.assign(button.style, {
      appearance: "none",
      border: "0",
      borderRadius: "999px",
      background: "transparent",
      color: "rgb(113, 118, 123)",
      cursor: "pointer",
      font: "500 12px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      lineHeight: "28px",
      padding: "0 8px",
      whiteSpace: "nowrap"
    });
    button.addEventListener("mouseenter", () => {
      if (button.disabled) return;
      button.style.background = hover.background;
      button.style.color = hover.color;
    });
    button.addEventListener("mouseleave", () => {
      button.style.background = "transparent";
      button.style.color = "rgb(113, 118, 123)";
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideReplyThenAct(article, button, action);
    });
    return button;
  }

  function createButton(article) {
    const group = document.createElement("span");
    group.setAttribute(BUTTON_ATTRIBUTE, "true");
    Object.assign(group.style, { display: "inline-flex", alignItems: "center" });
    group.append(createActionButton(article, "mute"), createActionButton(article, "block"));
    return group;
  }

  function installButtons() {
    if (!isSupportedPage()) {
      document
        .querySelectorAll(`[${BUTTON_ATTRIBUTE}]`)
        .forEach((button) => button.remove());
      return;
    }

    const ownHandle = loggedInHandle();
    if (!ownHandle) return;

    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const existingButton = article.querySelector(`[${BUTTON_ATTRIBUTE}]`);
      const authorHandle = articleAuthorHandle(article);

      // 不再根据当前 URL 判断主帖。只要作者不是当前登录账号，就允许清理；
      // 自己的帖子若残留旧按钮，立即移除。
      if (!authorHandle || isOwnArticle(article, ownHandle)) {
        existingButton?.remove();
        continue;
      }
      if (existingButton) continue;

      const actionGroup = findActionGroup(article);
      if (!actionGroup) continue;
      actionGroup.appendChild(createButton(article));
    }
  }

  let scheduled = false;
  function scheduleInstall() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      installButtons();
    });
  }

  new MutationObserver(scheduleInstall).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  window.addEventListener("popstate", scheduleInstall);
  // X 使用 History API 做无刷新跳转；定时检查可覆盖没有触发 popstate、
  // 页面 DOM 又恰好未变化的极端情况。
  setInterval(scheduleInstall, 1000);
  scheduleInstall();
})();
