"use strict";

const startPolishedUI = async () => {
  try {
    await browser.PolishedUI.start();
  } catch (error) {
    console.error("[FluentBird Polished UI] startup failed", error);
  }
};

browser.runtime.onStartup.addListener(startPolishedUI);
browser.runtime.onInstalled.addListener(startPolishedUI);
startPolishedUI();
