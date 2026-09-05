"use strict";

(function () {
  const ADDON_NAME = "FluentBird Polished UI";
  const AVATAR_COLORS = [
    "#3478c9",
    "#7b61c9",
    "#168f9c",
    "#2f8a5b",
    "#c06b2c",
    "#b94b68",
    "#536d9e",
    "#8a5a9e",
  ];
  const ACCOUNT_PREF_ROOT = "extensions.fluentbird.accountShortcuts.";

  const INJECTED_CSS = `
    .sender-avatar {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      box-sizing: border-box !important;
      overflow: hidden !important;
      color: white !important;
      font: 700 11px/1 system-ui, sans-serif !important;
      letter-spacing: .01em !important;
      user-select: none !important;
      pointer-events: none !important;
      z-index: 3 !important;
    }
    .tb-trash-btn {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      box-sizing: border-box !important;
      z-index: 4 !important;
    }
    tr[data-properties~="dummy"] :is(.sender-avatar, .tb-trash-btn) {
      display: none !important;
    }
  `;

  class PolishedUIController {
    constructor() {
      this.started = false;
      this.observers = new Map();
      this.pendingDocumentObservers = new Map();
      this.scrollGuards = new Map();
      this.accountShortcutCleanups = new Map();
      this.accountReadinessObservers = new Map();
      this.groupExpansionDeadlines = new Map();
      this.timers = new Set();
      this.windowListenerRegistered = false;
      this.documentObserver = {
        observe: subject => this.setupDocument(subject),
      };
      this.windowListener = {
        onOpenWindow: openedWindow => this.watchOpenedWindow(openedWindow),
        onCloseWindow() {},
        onWindowTitleChange() {},
      };
      this.topics = [
        "chrome-document-interactive",
        "content-document-interactive",
        "chrome-document-loaded",
        "content-document-loaded",
      ];
    }

    log(message) {
      try {
        Services.console.logStringMessage(`[${ADDON_NAME}] ${message}`);
      } catch (error) {}
    }

    colorFor(value) {
      let hash = 0;
      for (const character of value) {
        hash = (Math.imul(hash, 31) + character.codePointAt(0)) | 0;
      }
      return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
    }

    initialsFor(sender) {
      const withoutAddress = sender.replace(/<[^>]*>/g, "").trim();
      const fallback = sender.match(/([^@<\s]+)@/)?.[1] || "?";
      const words = (withoutAddress || fallback).split(/\s+/).filter(Boolean);
      if (words.length === 0) {
        return "?";
      }
      if (words.length === 1) {
        return words[0].slice(0, 2).toUpperCase();
      }
      return `${words[0][0]}${words.at(-1)[0]}`.toUpperCase();
    }

    injectStyle(document) {
      if (document.getElementById("fluentbird-polished-ui-style")) {
        return;
      }
      const style = document.createElement("style");
      style.id = "fluentbird-polished-ui-style";
      style.textContent = INJECTED_CSS;
      (document.head || document.documentElement).append(style);
    }

    deleteMessage(button, document) {
      const row = button.closest("tr.card-layout");
      const tree = document.getElementById("threadTree");
      const win = document.defaultView;
      if (!row || !tree || !win) {
        return;
      }

      try {
        const candidates = [row.index, row._index, row.dataset.index];
        let rowIndex = candidates
          .map(value => Number.parseInt(value, 10))
          .find(value => Number.isInteger(value) && value >= 0);

        if (rowIndex === undefined) {
          row.querySelector(".card-container")?.click();
        } else if ("selectedIndex" in tree) {
          tree.selectedIndex = rowIndex;
        } else if (tree.view?.selection) {
          tree.view.selection.select(rowIndex);
        }

        win.setTimeout(() => {
          try {
            if (typeof win.goDoCommand === "function") {
              win.goDoCommand("cmd_delete");
              return;
            }
            const topWindow = win.browsingContext?.topChromeWindow;
            topWindow?.goDoCommand?.("cmd_delete");
          } catch (error) {
            this.log(`delete failed: ${error}`);
          }
        }, 0);
      } catch (error) {
        this.log(`delete failed: ${error}`);
      }
    }

    updateCard(row, document) {
      const container = row.querySelector(".card-container");
      if (!container) {
        return;
      }

      if (row.dataset.properties?.split(/\s+/).includes("dummy")) {
        container.querySelectorAll(".sender-avatar, .tb-trash-btn").forEach(node => node.remove());
        return;
      }

      const sender = row.querySelector(".sender")?.textContent?.trim();
      if (sender) {
        let avatar = container.querySelector(".sender-avatar");
        if (!avatar) {
          avatar = document.createElement("span");
          avatar.className = "sender-avatar";
          avatar.setAttribute("aria-hidden", "true");
          container.prepend(avatar);
        }

        const initials = this.initialsFor(sender);
        const signature = `${sender}\u0000${initials}`;
        if (avatar.dataset.signature !== signature) {
          avatar.dataset.signature = signature;
          avatar.textContent = initials;
          avatar.style.setProperty("background-color", this.colorFor(sender), "important");
        }
      }

      if (!container.querySelector(".tb-trash-btn")) {
        const button = document.createElement("button");
        button.className = "tb-trash-btn";
        button.type = "button";
        button.title = "Delete message";
        button.setAttribute("aria-label", "Delete message");
        button.addEventListener("click", event => {
          event.preventDefault();
          event.stopPropagation();
          this.deleteMessage(button, document);
        });
        container.append(button);
      }
    }

    openDateGroups(document) {
      const deadline = this.groupExpansionDeadlines.get(document) || 0;
      if (Date.now() > deadline) {
        return;
      }

      const collapsedGroups = document.querySelectorAll(
        '#threadTree tr.card-layout[data-properties~="dummy"].collapsed, ' +
          '#threadTree tr.card-layout[data-properties~="dummy"][aria-expanded="false"]'
      );
      for (const row of collapsedGroups) {
        row.querySelector("button.twisty, .thread-card-button")?.click();
      }
    }

    setupScrollGuard(document, tree) {
      if (this.scrollGuards.has(document)) {
        return;
      }

      const win = document.defaultView;
      let snapshot = null;
      let generation = 0;
      const pendingTimers = new Set();

      const cancelPending = () => {
        generation++;
        snapshot = null;
        for (const timer of pendingTimers) {
          win.clearTimeout(timer);
        }
        pendingTimers.clear();
      };

      const onPointerDown = event => {
        const row = event.target.closest?.("tr.card-layout");
        const isAction = event.target.closest?.(
          "button, a, input, select, textarea, .tb-trash-btn"
        );
        if (event.button !== 0 || !row || isAction) {
          cancelPending();
          return;
        }
        cancelPending();
        snapshot = {
          top: tree.scrollTop,
          left: tree.scrollLeft,
        };
      };

      const onClick = event => {
        if (!snapshot || !event.target.closest?.("tr.card-layout")) {
          return;
        }
        const saved = snapshot;
        snapshot = null;
        const token = generation;
        const restore = () => {
          if (token !== generation || !tree.isConnected) {
            return;
          }
          tree.scrollTop = saved.top;
          tree.scrollLeft = saved.left;
        };

        // Thunderbird can request a second scroll after the message pane loads.
        // Restore over a short window, but cancel immediately on deliberate input.
        for (const delay of [0, 35, 100, 220]) {
          const timer = win.setTimeout(() => {
            pendingTimers.delete(timer);
            restore();
          }, delay);
          pendingTimers.add(timer);
        }
      };

      const onManualNavigation = () => cancelPending();
      tree.addEventListener("pointerdown", onPointerDown, true);
      tree.addEventListener("click", onClick, true);
      tree.addEventListener("wheel", onManualNavigation, { passive: true });
      tree.addEventListener("touchstart", onManualNavigation, { passive: true });
      tree.addEventListener("keydown", onManualNavigation, true);

      this.scrollGuards.set(document, () => {
        cancelPending();
        tree.removeEventListener("pointerdown", onPointerDown, true);
        tree.removeEventListener("click", onClick, true);
        tree.removeEventListener("wheel", onManualNavigation);
        tree.removeEventListener("touchstart", onManualNavigation);
        tree.removeEventListener("keydown", onManualNavigation, true);
      });
    }

    findPreferredFolder(rootRow) {
      if (!rootRow) {
        return null;
      }
      const folders = Array.from(
        rootRow.querySelectorAll('li[is="folder-tree-row"]')
      );
      const normalName = row =>
        row.querySelector(":scope > .container > .name")?.textContent
          ?.trim()
          .toLocaleLowerCase() || "";
      return (
        folders.find(row => normalName(row) === "all mail") ||
        folders.find(row => row.dataset.folderType === "inbox") ||
        folders.find(row => normalName(row) === "inbox") ||
        null
      );
    }

    mirrorAccountBadge(sourceRoot, shortcut) {
      const sourceBadge = sourceRoot?.querySelector(
        ":scope > .container > .folder-count-badge"
      );
      const shortcutBadge = shortcut?.querySelector(
        ":scope > .container > .folder-count-badge"
      );
      if (!sourceBadge || !shortcutBadge) {
        return;
      }
      shortcutBadge.className = sourceBadge.className;
      shortcutBadge.textContent = sourceBadge.textContent;
      shortcutBadge.hidden = sourceBadge.hidden;
      for (const attribute of ["aria-label", "title"]) {
        if (sourceBadge.hasAttribute(attribute)) {
          shortcutBadge.setAttribute(
            attribute,
            sourceBadge.getAttribute(attribute)
          );
        } else {
          shortcutBadge.removeAttribute(attribute);
        }
      }
    }

    syncAccountBadges(document) {
      const folderTree = document.getElementById("folderTree");
      if (!folderTree) {
        return;
      }
      const sourceRoots = new Map(
        Array.from(
          folderTree.querySelectorAll(
            'li[is="folder-tree-row"][data-server-type][data-server-key]'
          )
        )
          .filter(row => row.modeName === "all")
          .map(row => [row.dataset.serverKey, row])
      );
      for (const shortcut of folderTree.querySelectorAll(
        ".fb-account-shortcut[data-server-key]"
      )) {
        this.mirrorAccountBadge(
          sourceRoots.get(shortcut.dataset.serverKey),
          shortcut
        );
      }
    }

    accountProvider(accountName, serverKey, customGroups, customAssignments) {
      const customGroupID = customAssignments?.[serverKey];
      const customGroup = customGroups?.find(group => group.id === customGroupID);
      if (customGroup) {
        return {
          key: `custom:${customGroup.id}`,
          label: customGroup.name,
          order: 0,
          domains: [],
        };
      }
      const domain =
        accountName
          .trim()
          .toLocaleLowerCase()
          .match(/@([^\s>]+)$/)?.[1]
          ?.replace(/[>,;]+$/, "") || "other";
      const knownProviders = [
        { key: "gmail", label: "Gmail", order: 10, domains: ["gmail.com", "googlemail.com"] },
        { key: "outlook", label: "Outlook", order: 20, domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"] },
        { key: "icloud", label: "iCloud", order: 30, domains: ["icloud.com", "me.com", "mac.com"] },
        { key: "yahoo", label: "Yahoo", order: 40, domains: ["yahoo.com", "ymail.com", "rocketmail.com"] },
        { key: "proton", label: "Proton Mail", order: 50, domains: ["proton.me", "protonmail.com", "pm.me"] },
        { key: "aol", label: "AOL", order: 60, domains: ["aol.com"] },
        { key: "zoho", label: "Zoho Mail", order: 70, domains: ["zoho.com", "zohomail.com"] },
        { key: "fastmail", label: "Fastmail", order: 80, domains: ["fastmail.com", "fastmail.fm"] },
        { key: "gmx", label: "GMX", order: 90, domains: ["gmx.com", "gmx.net", "gmx.co.uk"] },
        { key: "mailcom", label: "Mail.com", order: 100, domains: ["mail.com"] },
        { key: "yandex", label: "Yandex Mail", order: 110, domains: ["yandex.com", "yandex.ru"] },
        { key: "tuta", label: "Tuta", order: 120, domains: ["tuta.com", "tutanota.com", "tutanota.de"] },
      ];
      const known = knownProviders.find(provider =>
        provider.domains.some(
          providerDomain =>
            domain === providerDomain || domain.endsWith(`.${providerDomain}`)
        )
      );
      if (known) {
        return known;
      }
      const label =
        domain === "other"
          ? "Other"
          : domain
              .split(".")[0]
              .replace(/(^|[-_])\p{L}/gu, character =>
                character.replace(/[-_]/, " ").toLocaleUpperCase()
              );
      return {
        key: `domain:${domain}`,
        label,
        order: 100,
        domains: [domain],
      };
    }

    readAccountPreference(name, fallback) {
      try {
        const raw = Services.prefs.getStringPref(`${ACCOUNT_PREF_ROOT}${name}`, "");
        return raw ? JSON.parse(raw) : fallback;
      } catch (error) {
        return fallback;
      }
    }

    writeAccountPreference(name, value) {
      try {
        Services.prefs.setStringPref(
          `${ACCOUNT_PREF_ROOT}${name}`,
          JSON.stringify(value)
        );
      } catch (error) {
        this.log(`could not save account-list preference: ${error}`);
      }
    }

    clearAccountPreference(name) {
      try {
        const preference = `${ACCOUNT_PREF_ROOT}${name}`;
        if (Services.prefs.prefHasUserValue(preference)) {
          Services.prefs.clearUserPref(preference);
        }
      } catch (error) {
        this.log(`could not clear account-list preference: ${error}`);
      }
    }

    moveBefore(values, source, target, placeAfter = false) {
      const result = values.filter(value => value !== source);
      const targetIndex = result.indexOf(target);
      result.splice(
        targetIndex < 0 ? result.length : targetIndex + (placeAfter ? 1 : 0),
        0,
        source
      );
      return result;
    }

    setupAccountShortcuts(document) {
      const folderTree = document.getElementById("folderTree");
      if (!folderTree) {
        return;
      }

      const rows = Array.from(
        folderTree.querySelectorAll('li[is="folder-tree-row"][data-server-type]')
      );
      const allRoots = rows.filter(row => row.modeName === "all");
      const favoriteRoots = rows.filter(row => row.modeName === "favorite");
      let modeHost = favoriteRoots[0]?.parentElement?.closest("li.unselectable");
      if (!modeHost) {
        modeHost = Array.from(
          folderTree.querySelectorAll(":scope > li.unselectable")
        ).find(item =>
          /favou?rite/i.test(item.querySelector(":scope > .mode-container > .mode-name")?.textContent || "")
        );
      }
      const modeList = modeHost?.querySelector(":scope > ul");
      if (!modeHost || !modeList) {
        return;
      }

      const allModeHost = allRoots[0]?.parentElement?.closest("li.unselectable");
      allModeHost?.classList.add("fb-all-folders-mode");

      modeHost.classList.add("fb-account-shortcut-mode");
      const modeName = modeHost.querySelector(
        ":scope > .mode-container > .mode-name"
      );
      if (modeName) {
        if (!modeName.dataset.fbOriginalText) {
          modeName.dataset.fbOriginalText = modeName.textContent;
        }
        modeName.textContent = "Email Accounts";
      }


      const densities = ["compact", "comfortable", "spacious"];
      let density = this.readAccountPreference("density", "comfortable");
      if (!densities.includes(density)) {
        density = "comfortable";
      }
      modeHost.dataset.fbDensity = density;
      const showCounts = this.readAccountPreference("showCounts", true) !== false;
      const showAllFolders =
        this.readAccountPreference("showAllFolders", true) !== false;
      const showHeaderButtons =
        this.readAccountPreference("showHeaderButtons", true) !== false;
      const groupAccounts =
        this.readAccountPreference("groupAccounts", true) !== false;
      const savedCustomGroups = this.readAccountPreference("customGroups", []);
      const customGroups = Array.isArray(savedCustomGroups)
        ? savedCustomGroups.filter(
            group =>
              group &&
              typeof group.id === "string" &&
              typeof group.name === "string" &&
              group.name.trim()
          )
        : [];
      const savedCustomAssignments = this.readAccountPreference(
        "customAssignments",
        {}
      );
      const customAssignments =
        savedCustomAssignments &&
        typeof savedCustomAssignments === "object" &&
        !Array.isArray(savedCustomAssignments)
          ? savedCustomAssignments
          : {};
      modeHost.dataset.fbShowCounts = String(showCounts);
      modeHost.dataset.fbShowHeaderButtons = String(showHeaderButtons);
      modeHost.dataset.fbGroupAccounts = String(groupAccounts);
      allModeHost?.classList.toggle(
        "fb-all-folders-hidden",
        !showAllFolders
      );

      const modeContainer = modeHost.querySelector(":scope > .mode-container");
      let controls = modeContainer?.querySelector(":scope > .fb-account-controls");
      let onHiddenHeaderContextMenu = null;
      if (modeContainer && !controls) {
        controls = document.createElement("span");
        controls.className = "fb-account-controls";

        const densityButton = document.createElement("button");
        densityButton.type = "button";
        densityButton.className = "fb-account-density-button";
        densityButton.textContent = "Aa";
        densityButton.setAttribute("aria-label", "Change account list size");

        const visibilityButton = document.createElement("button");
        visibilityButton.type = "button";
        visibilityButton.className = "fb-account-visibility-button";
        visibilityButton.textContent = "⚙";
        visibilityButton.setAttribute("aria-label", "Account list options");
        visibilityButton.title = "Account list options";

        controls.append(densityButton, visibilityButton);
        modeContainer.append(controls);

        const updateDensityTitle = () => {
          const current = modeHost.dataset.fbDensity || "comfortable";
          densityButton.title = `Account size: ${current}. Click to change.`;
        };
        updateDensityTitle();

        densityButton.addEventListener("click", event => {
          event.preventDefault();
          event.stopPropagation();
          const current = modeHost.dataset.fbDensity || "comfortable";
          const next = densities[(densities.indexOf(current) + 1) % densities.length];
          modeHost.dataset.fbDensity = next;
          this.writeAccountPreference("density", next);
          updateDensityTitle();
        });

        visibilityButton.addEventListener("click", event => {
          event.preventDefault();
          event.stopPropagation();
          let panel = document.querySelector(".fb-account-visibility-panel");
          if (panel) {
            panel.remove();
            return;
          }

          panel = document.createElement("div");
          panel.className = "fb-account-visibility-panel";
          panel.setAttribute("role", "dialog");
          panel.setAttribute("aria-label", "Visible email accounts");

          const title = document.createElement("strong");
          title.textContent = "Account list options";
          panel.append(title);

          const createOption = (textContent, checked, onChange) => {
            const label = document.createElement("label");
            label.className = "fb-account-option-toggle";
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = checked;
            checkbox.addEventListener("change", () => onChange(checkbox.checked));
            const text = document.createElement("span");
            text.textContent = textContent;
            label.append(checkbox, text);
            panel.append(label);
          };

          createOption(
            "Group accounts under headers",
            modeHost.dataset.fbGroupAccounts !== "false",
            checked => {
              this.writeAccountPreference("groupAccounts", checked);
              modeHost.dataset.fbGroupAccounts = String(checked);
              this.setupAccountShortcuts(document);
            }
          );
          createOption(
            "Show unread counts",
            modeHost.dataset.fbShowCounts !== "false",
            checked => {
              this.writeAccountPreference("showCounts", checked);
              modeHost.dataset.fbShowCounts = String(checked);
              this.setupAccountShortcuts(document);
            }
          );
          createOption(
            "Show All Folders section",
            !allModeHost?.classList.contains("fb-all-folders-hidden"),
            checked => {
              this.writeAccountPreference("showAllFolders", checked);
              allModeHost?.classList.toggle("fb-all-folders-hidden", !checked);
            }
          );
          createOption(
            "Show header buttons",
            modeHost.dataset.fbShowHeaderButtons !== "false",
            checked => {
              this.writeAccountPreference("showHeaderButtons", checked);
              modeHost.dataset.fbShowHeaderButtons = String(checked);
            }
          );

          const restoreHint = document.createElement("small");
          restoreHint.className = "fb-account-options-hint";
          restoreHint.textContent =
            "If the header buttons are hidden, right-click Email Accounts to reopen these options.";
          panel.append(restoreHint);

          const configuredCustomGroups = (() => {
            const groups = this.readAccountPreference("customGroups", []);
            return Array.isArray(groups)
              ? groups.filter(
                  group =>
                    group &&
                    typeof group.id === "string" &&
                    typeof group.name === "string" &&
                    group.name.trim()
                )
              : [];
          })();
          const configuredAssignments = (() => {
            const assignments = this.readAccountPreference(
              "customAssignments",
              {}
            );
            return assignments &&
              typeof assignments === "object" &&
              !Array.isArray(assignments)
              ? assignments
              : {};
          })();
          const reopenOptions = () => {
            panel.remove();
            visibilityButton.click();
          };

          const customGroupsTitle = document.createElement("strong");
          customGroupsTitle.className = "fb-account-panel-subheading";
          customGroupsTitle.textContent = "Custom headers";
          panel.append(customGroupsTitle);

          const customGroupActions = document.createElement("div");
          customGroupActions.className = "fb-custom-group-actions";
          const addCustomGroupButton = document.createElement("button");
          addCustomGroupButton.type = "button";
          addCustomGroupButton.textContent = "+ Create header";
          addCustomGroupButton.addEventListener("click", () => {
            const name = document.defaultView
              .prompt("Name for the new email account header:", "Work")
              ?.trim();
            if (!name) {
              return;
            }
            configuredCustomGroups.push({
              id: `group-${Date.now().toString(36)}-${Math.random()
                .toString(36)
                .slice(2, 8)}`,
              name: name.slice(0, 48),
            });
            this.writeAccountPreference(
              "customGroups",
              configuredCustomGroups
            );
            this.setupAccountShortcuts(document);
            reopenOptions();
          });
          customGroupActions.append(addCustomGroupButton);
          panel.append(customGroupActions);

          for (const group of configuredCustomGroups) {
            const groupRow = document.createElement("div");
            groupRow.className = "fb-custom-group-row";
            const groupName = document.createElement("span");
            groupName.textContent = group.name;
            const renameButton = document.createElement("button");
            renameButton.type = "button";
            renameButton.title = `Rename ${group.name}`;
            renameButton.textContent = "Rename";
            renameButton.addEventListener("click", () => {
              const name = document.defaultView
                .prompt("Rename email account header:", group.name)
                ?.trim();
              if (!name) {
                return;
              }
              group.name = name.slice(0, 48);
              this.writeAccountPreference(
                "customGroups",
                configuredCustomGroups
              );
              this.setupAccountShortcuts(document);
              reopenOptions();
            });
            const deleteButton = document.createElement("button");
            deleteButton.type = "button";
            deleteButton.title = `Delete ${group.name}`;
            deleteButton.textContent = "Delete";
            deleteButton.addEventListener("click", () => {
              if (
                !document.defaultView.confirm(
                  `Delete the custom header “${group.name}”? Accounts will return to their automatic provider groups.`
                )
              ) {
                return;
              }
              const remainingGroups = configuredCustomGroups.filter(
                candidate => candidate.id !== group.id
              );
              for (const [serverKey, groupID] of Object.entries(
                configuredAssignments
              )) {
                if (groupID === group.id) {
                  delete configuredAssignments[serverKey];
                }
              }
              this.writeAccountPreference("customGroups", remainingGroups);
              this.writeAccountPreference(
                "customAssignments",
                configuredAssignments
              );
              this.setupAccountShortcuts(document);
              reopenOptions();
            });
            groupRow.append(groupName, renameButton, deleteButton);
            panel.append(groupRow);
          }

          const accountsTitle = document.createElement("strong");
          accountsTitle.className = "fb-account-panel-subheading";
          accountsTitle.textContent = "Accounts shown";
          panel.append(accountsTitle);

          const hiddenServers = new Set(
            this.readAccountPreference("hiddenServers", [])
          );
          const accountRows = Array.from(
            folderTree.querySelectorAll(
              'li[is="folder-tree-row"][data-server-type][data-server-key]'
            )
          )
            .filter(row => row.modeName === "all")
            .filter(
              (row, index, rows) =>
                rows.findIndex(
                  candidate => candidate.dataset.serverKey === row.dataset.serverKey
                ) === index
            )
            .map(row => ({
              serverKey: row.dataset.serverKey,
              name:
                row.querySelector(":scope > .container > .name")?.textContent?.trim() ||
                row.dataset.serverKey,
            }))
            .sort((left, right) => left.name.localeCompare(right.name));

          for (const account of accountRows) {
            const label = document.createElement("label");
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = !hiddenServers.has(account.serverKey);
            checkbox.addEventListener("change", () => {
              if (checkbox.checked) {
                hiddenServers.delete(account.serverKey);
              } else {
                hiddenServers.add(account.serverKey);
              }
              this.writeAccountPreference(
                "hiddenServers",
                Array.from(hiddenServers)
              );
              this.setupAccountShortcuts(document);
            });
            const text = document.createElement("span");
            text.textContent = account.name;
            const groupSelect = document.createElement("select");
            groupSelect.title = `Custom header for ${account.name}`;
            const automaticOption = document.createElement("option");
            automaticOption.value = "";
            automaticOption.textContent = "Automatic";
            groupSelect.append(automaticOption);
            for (const group of configuredCustomGroups) {
              const option = document.createElement("option");
              option.value = group.id;
              option.textContent = group.name;
              groupSelect.append(option);
            }
            groupSelect.value = configuredAssignments[account.serverKey] || "";
            groupSelect.addEventListener("change", () => {
              if (groupSelect.value) {
                configuredAssignments[account.serverKey] = groupSelect.value;
              } else {
                delete configuredAssignments[account.serverKey];
              }
              this.writeAccountPreference(
                "customAssignments",
                configuredAssignments
              );
              this.setupAccountShortcuts(document);
            });
            label.append(checkbox, text, groupSelect);
            panel.append(label);
          }

          const resetButton = document.createElement("button");
          resetButton.type = "button";
          resetButton.className = "fb-account-reset-order";
          resetButton.textContent = "Reset custom order";
          resetButton.addEventListener("click", () => {
            this.clearAccountPreference("accountOrder");
            this.clearAccountPreference("providerOrder");
            this.setupAccountShortcuts(document);
            resetButton.textContent = "Custom order reset";
          });
          panel.append(resetButton);

          document.body.append(panel);
          const buttonRect = visibilityButton.getBoundingClientRect();
          const panelRect = panel.getBoundingClientRect();
          panel.style.top = `${Math.min(
            buttonRect.bottom + 5,
            document.defaultView.innerHeight - panelRect.height - 8
          )}px`;
          panel.style.left = `${Math.max(
            8,
            Math.min(buttonRect.right - panelRect.width, document.defaultView.innerWidth - panelRect.width - 8)
          )}px`;
        });

        onHiddenHeaderContextMenu = event => {
          if (modeHost.dataset.fbShowHeaderButtons !== "false") {
            return;
          }
          event.preventDefault();
          event.stopImmediatePropagation();
          visibilityButton.click();
        };
        modeContainer.addEventListener(
          "contextmenu",
          onHiddenHeaderContextMenu,
          true
        );
      } else {
        controls?.querySelector(".fb-account-density-button")?.setAttribute(
          "title",
          `Account size: ${density}. Click to change.`
        );
      }

      const rootsByServer = new Map();
      for (const root of allRoots) {
        rootsByServer.set(root.dataset.serverKey, root);
      }

      const shortcutsByServer = new Map();
      for (const row of favoriteRoots) {
        shortcutsByServer.set(row.dataset.serverKey, row);
      }
      const hiddenServers = new Set(
        this.readAccountPreference("hiddenServers", [])
      );
      const accountOrder = this.readAccountPreference("accountOrder", []);
      const providerOrder = this.readAccountPreference("providerOrder", []);

      // Synthetic shortcuts are plain list rows, so they are intentionally
      // absent from `favoriteRoots`. Include them explicitly and remove any
      // duplicates left by an older build before adding new accounts.
      for (const row of modeList.querySelectorAll(
        ":scope > .fb-synthetic-account-shortcut[data-server-key]"
      )) {
        const serverKey = row.dataset.serverKey;
        if (!serverKey || shortcutsByServer.has(serverKey)) {
          row.remove();
          continue;
        }
        shortcutsByServer.set(serverKey, row);
      }

      for (const [serverKey, allRoot] of rootsByServer) {
        let shortcut = shortcutsByServer.get(serverKey);
        if (!shortcut) {
          shortcut = document.createElement("li");
          shortcut.className = "fb-account-shortcut fb-synthetic-account-shortcut";
          shortcut.dataset.serverKey = serverKey;
          shortcut.dataset.serverType = allRoot.dataset.serverType;
          shortcut.modeName = "favorite";
          shortcut.setAttribute("role", "treeitem");
          shortcut.append(
            document.getElementById("folderTemplate").content.cloneNode(true)
          );
          const sourceName = allRoot.querySelector(
            ":scope > .container > .name"
          )?.textContent;
          shortcut.querySelector(":scope > .container > .name").textContent =
            sourceName || serverKey;
          modeList.append(shortcut);
          shortcutsByServer.set(serverKey, shortcut);
        }

        shortcut.classList.add("fb-account-shortcut");
        shortcut.classList.toggle(
          "fb-account-hidden",
          hiddenServers.has(serverKey)
        );
        // Prefer the folder row already inside the Favourite mode. Selecting
        // that row avoids expanding the matching account under All Folders.
        const target =
          this.findPreferredFolder(shortcut) ||
          this.findPreferredFolder(allRoot);
        shortcut._fbTargetFolderRow = target;
        shortcut._fbTargetFolderURI = target?.uri || null;
        if (
          target?.uri &&
          !Object.prototype.hasOwnProperty.call(shortcut, "_fbOriginalURI")
        ) {
          shortcut._fbOriginalURI = shortcut.uri;
        }
        if (target?.uri) {
          // Make the visible shortcut itself represent the target folder. This
          // lets the tree select the clicked row without revealing the copy of
          // that folder under All Folders.
          shortcut.uri = target.uri;
        }
        const targetName = target?.querySelector(
          ":scope > .container > .name"
        )?.textContent;
        shortcut.title = targetName
          ? `Open ${targetName}`
          : "No All Mail or Inbox folder found";

        // Mirror Thunderbird's native account-root badge so the shortcut uses
        // the same live unread value and visual treatment as All Folders.
        this.mirrorAccountBadge(allRoot, shortcut);
      }

      // Rebuild lightweight provider headings and keep both provider groups
      // and accounts in a predictable order.
      modeList
        .querySelectorAll(":scope > .fb-provider-heading")
        .forEach(row => row.remove());
      const sortedShortcuts = Array.from(shortcutsByServer.values())
        .filter(row => row.isConnected && !row.classList.contains("fb-account-hidden"))
        .map(row => {
          const name =
            row.querySelector(":scope > .container > .name")?.textContent?.trim() ||
            row.dataset.serverKey ||
            "";
          const provider = groupAccounts
            ? this.accountProvider(
                name,
                row.dataset.serverKey,
                customGroups,
                customAssignments
              )
            : { key: "flat", label: "", order: 0, domains: [] };
          return { row, name, provider };
        })
        .sort(
          (left, right) =>
            (providerOrder.indexOf(left.provider.key) < 0
              ? 1000 + left.provider.order
              : providerOrder.indexOf(left.provider.key)) -
              (providerOrder.indexOf(right.provider.key) < 0
                ? 1000 + right.provider.order
                : providerOrder.indexOf(right.provider.key)) ||
            left.provider.label.localeCompare(right.provider.label) ||
            (accountOrder.indexOf(left.row.dataset.serverKey) < 0
              ? 10000
              : accountOrder.indexOf(left.row.dataset.serverKey)) -
              (accountOrder.indexOf(right.row.dataset.serverKey) < 0
                ? 10000
                : accountOrder.indexOf(right.row.dataset.serverKey)) ||
            left.name.localeCompare(right.name)
        );
      let previousProviderKey = null;
      for (const item of sortedShortcuts) {
        if (
          groupAccounts &&
          item.provider.key !== previousProviderKey
        ) {
          const heading = document.createElement("li");
          heading.className = "fb-provider-heading unselectable";
          heading.textContent = item.provider.label;
          heading.dataset.providerKey = item.provider.key;
          heading.draggable = true;
          heading.setAttribute("aria-hidden", "true");
          modeList.append(heading);
          previousProviderKey = item.provider.key;
        }
        item.row.draggable = true;
        item.row.dataset.providerKey = item.provider.key;
        modeList.append(item.row);
      }

      // Keep the visual state exclusive. An older shortcut can retain its
      // custom active class after Thunderbird moves the native selection, so
      // first clear every shortcut and then mark only the currently displayed
      // folder's proxy row.
      const selectedRow = folderTree.selectedRow;
      const selectedURI = selectedRow?.uri || null;
      for (const { row } of sortedShortcuts) {
        row.classList.remove("fb-active-account-shortcut");
      }
      const activeShortcut = sortedShortcuts.find(
        ({ row }) =>
          row === selectedRow ||
          (selectedURI && row._fbTargetFolderURI === selectedURI)
      )?.row;
      activeShortcut?.classList.add("fb-active-account-shortcut");

      if (this.accountShortcutCleanups.has(document)) {
        return;
      }

      const onClick = event => {
        const shortcut = event.target.closest?.("li.fb-account-shortcut");
        if (!shortcut) {
          return;
        }
        const clickedContainer = event.target.closest?.(".container");
        const shortcutContainer = shortcut.querySelector(":scope > .container");
        if (clickedContainer !== shortcutContainer) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        const target = shortcut._fbTargetFolderRow;
        const targetURI = shortcut._fbTargetFolderURI || target?.uri;
        if (!targetURI) {
          return;
        }

        // Select the visible shortcut rather than calling displayFolder().
        // displayFolder() deliberately reveals and scrolls to the matching
        // row in All Folders; selecting this proxy row opens the same URI
        // without changing the All Folders expansion or scroll position.
        shortcut.uri = targetURI;
        const savedScrollTop = folderTree.scrollTop;
        const savedScrollLeft = folderTree.scrollLeft;
        if (typeof folderTree.updateSelection === "function") {
          modeList
            .querySelectorAll(":scope > .fb-account-shortcut")
            .forEach(row => row.classList.remove("fb-active-account-shortcut"));
          folderTree.updateSelection(shortcut);
          shortcut.classList.add("fb-active-account-shortcut");
          folderTree.scrollTop = savedScrollTop;
          folderTree.scrollLeft = savedScrollLeft;
        }
      };

      // Listen above the custom tree element so its native account-row click
      // handler cannot open Account Central before the redirect runs.
      document.addEventListener("click", onClick, true);

      const onFolderSelect = () => {
        const selectedRow = folderTree.selectedRow;
        const selectedURI = selectedRow?.uri || null;
        const shortcuts = modeList.querySelectorAll(
          ":scope > .fb-account-shortcut"
        );
        for (const row of shortcuts) {
          row.classList.toggle(
            "fb-active-account-shortcut",
            row === selectedRow ||
              Boolean(selectedURI && row._fbTargetFolderURI === selectedURI)
          );
        }
      };
      folderTree.addEventListener("select", onFolderSelect);

      let draggedItem = null;
      const clearDragState = () => {
        modeList
          .querySelectorAll(".fb-dragging, .fb-drop-target")
          .forEach(row => {
            row.classList.remove("fb-dragging", "fb-drop-target");
            delete row.dataset.fbDropPosition;
          });
        draggedItem = null;
      };
      const onDragStart = event => {
        const row = event.target.closest?.(
          ".fb-account-shortcut, .fb-provider-heading"
        );
        if (!row || !modeList.contains(row)) {
          return;
        }
        event.stopImmediatePropagation();
        draggedItem = row.classList.contains("fb-provider-heading")
          ? { type: "provider", key: row.dataset.providerKey, row }
          : {
              type: "account",
              key: row.dataset.serverKey,
              providerKey: row.dataset.providerKey,
              row,
            };
        row.classList.add("fb-dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(
          "text/plain",
          `${draggedItem.type}:${draggedItem.key}`
        );
      };
      const onDragOver = event => {
        if (!draggedItem) {
          return;
        }
        event.stopImmediatePropagation();
        const target = event.target.closest?.(
          ".fb-account-shortcut, .fb-provider-heading"
        );
        const validTarget =
          target &&
          target !== draggedItem.row &&
          ((draggedItem.type === "provider" &&
            target.classList.contains("fb-provider-heading")) ||
            (draggedItem.type === "account" &&
              target.classList.contains("fb-account-shortcut") &&
              target.dataset.providerKey === draggedItem.providerKey));
        modeList
          .querySelectorAll(".fb-drop-target")
          .forEach(row => row.classList.remove("fb-drop-target"));
        if (!validTarget) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        target.classList.add("fb-drop-target");
        const targetRect = target.getBoundingClientRect();
        target.dataset.fbDropPosition =
          event.clientY >= targetRect.top + targetRect.height / 2
            ? "after"
            : "before";
      };
      const onDrop = event => {
        if (!draggedItem) {
          return;
        }
        const target = event.target.closest?.(
          ".fb-account-shortcut, .fb-provider-heading"
        );
        event.preventDefault();
        event.stopImmediatePropagation();
        if (draggedItem.type === "provider" && target?.classList.contains("fb-provider-heading")) {
          const providerKeys = Array.from(
            modeList.querySelectorAll(":scope > .fb-provider-heading")
          ).map(row => row.dataset.providerKey);
          this.writeAccountPreference(
            "providerOrder",
            this.moveBefore(
              providerKeys,
              draggedItem.key,
              target.dataset.providerKey,
              target.dataset.fbDropPosition === "after"
            )
          );
        } else if (
          draggedItem.type === "account" &&
          target?.classList.contains("fb-account-shortcut") &&
          target.dataset.providerKey === draggedItem.providerKey
        ) {
          const accountKeys = Array.from(
            modeList.querySelectorAll(":scope > .fb-account-shortcut[data-server-key]")
          ).map(row => row.dataset.serverKey);
          this.writeAccountPreference(
            "accountOrder",
            this.moveBefore(
              accountKeys,
              draggedItem.key,
              target.dataset.serverKey,
              target.dataset.fbDropPosition === "after"
            )
          );
        }
        clearDragState();
        this.setupAccountShortcuts(document);
      };
      const onDragEnd = event => {
        if (draggedItem) {
          event.stopImmediatePropagation();
        }
        clearDragState();
      };
      document.addEventListener("dragstart", onDragStart, true);
      document.addEventListener("dragover", onDragOver, true);
      document.addEventListener("drop", onDrop, true);
      document.addEventListener("dragend", onDragEnd, true);

      const onOutsidePointerDown = event => {
        const panel = document.querySelector(".fb-account-visibility-panel");
        if (
          panel &&
          !panel.contains(event.target) &&
          !controls?.contains(event.target)
        ) {
          panel.remove();
        }
      };
      document.addEventListener("pointerdown", onOutsidePointerDown, true);

      // Account rows and unread counts can change after start-up. Observe only
      // Thunderbird's native All Folders mode: observing the entire tree (and
      // especially its class changes) causes a rebuild storm while accounts
      // synchronise. Debounce bursts into one inexpensive refresh.
      const accountObservationRoot = allModeHost || folderTree;
      let accountRefreshTimer = null;
      let accountNeedsRebuild = false;
      const accountTreeObserver = new document.defaultView.MutationObserver(
        mutations => {
          const rootSelector =
            'li[is="folder-tree-row"][data-server-type][data-server-key]';
          accountNeedsRebuild ||= mutations.some(mutation => {
            if (mutation.type === "attributes") {
              return ["data-server-key", "data-server-type"].includes(
                mutation.attributeName
              );
            }
            if (mutation.type !== "childList") {
              return false;
            }
            return [...mutation.addedNodes, ...mutation.removedNodes].some(
              node =>
                node.nodeType === 1 &&
                (node.matches?.(rootSelector) ||
                  node.querySelector?.(rootSelector))
            );
          });
          if (accountRefreshTimer !== null) {
            document.defaultView.clearTimeout(accountRefreshTimer);
          }
          accountRefreshTimer = document.defaultView.setTimeout(() => {
            accountRefreshTimer = null;
            if (accountNeedsRebuild) {
              accountNeedsRebuild = false;
              this.setupAccountShortcuts(document);
            } else {
              this.syncAccountBadges(document);
            }
          }, 120);
        }
      );
      accountTreeObserver.observe(accountObservationRoot, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: [
          "data-server-key",
          "data-server-type",
          "class",
          "hidden",
          "aria-label",
          "title",
        ],
      });
      this.accountShortcutCleanups.set(document, () => {
        accountTreeObserver.disconnect();
        if (accountRefreshTimer !== null) {
          document.defaultView.clearTimeout(accountRefreshTimer);
          accountRefreshTimer = null;
        }
        clearDragState();
        document.removeEventListener("click", onClick, true);
        folderTree.removeEventListener("select", onFolderSelect);
        document.removeEventListener("dragstart", onDragStart, true);
        document.removeEventListener("dragover", onDragOver, true);
        document.removeEventListener("drop", onDrop, true);
        document.removeEventListener("dragend", onDragEnd, true);
        document.removeEventListener("pointerdown", onOutsidePointerDown, true);
        document.querySelector(".fb-account-visibility-panel")?.remove();
        if (onHiddenHeaderContextMenu) {
          modeContainer?.removeEventListener(
            "contextmenu",
            onHiddenHeaderContextMenu,
            true
          );
        }
        controls?.remove();
        modeHost
          .querySelectorAll(".fb-synthetic-account-shortcut")
          .forEach(row => row.remove());
        modeHost
          .querySelectorAll(".fb-provider-heading")
          .forEach(row => row.remove());
        modeHost
          .querySelectorAll(".fb-account-shortcut")
          .forEach(row => {
            if (Object.prototype.hasOwnProperty.call(row, "_fbOriginalURI")) {
              row.uri = row._fbOriginalURI;
              delete row._fbOriginalURI;
            }
            row.classList.remove(
              "fb-account-shortcut",
              "fb-active-account-shortcut",
              "fb-account-hidden",
              "fb-dragging",
              "fb-drop-target"
            );
            row.removeAttribute("draggable");
            delete row.dataset.providerKey;
          });
        modeHost.classList.remove("fb-account-shortcut-mode");
        delete modeHost.dataset.fbDensity;
        delete modeHost.dataset.fbShowCounts;
        delete modeHost.dataset.fbShowHeaderButtons;
        delete modeHost.dataset.fbGroupAccounts;
        allModeHost?.classList.remove(
          "fb-all-folders-mode",
          "fb-all-folders-hidden"
        );
        if (modeName?.dataset.fbOriginalText) {
          modeName.textContent = modeName.dataset.fbOriginalText;
          delete modeName.dataset.fbOriginalText;
        }
      });
    }

    ensureAccountShortcuts(document) {
      this.setupAccountShortcuts(document);
      if (
        this.accountShortcutCleanups.has(document) ||
        this.accountReadinessObservers.has(document) ||
        !document?.documentElement ||
        !document.defaultView
      ) {
        return;
      }

      const win = document.defaultView;
      let animationFrame = null;
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) {
          return;
        }
        cleanedUp = true;
        observer.disconnect();
        if (animationFrame !== null) {
          win.cancelAnimationFrame(animationFrame);
          animationFrame = null;
        }
        win.removeEventListener("unload", cleanup);
        if (this.accountReadinessObservers.get(document) === cleanup) {
          this.accountReadinessObservers.delete(document);
        }
      };
      const observer = new win.MutationObserver(() => {
        if (animationFrame !== null) {
          return;
        }
        animationFrame = win.requestAnimationFrame(() => {
          animationFrame = null;
          if (!this.started) {
            cleanup();
            return;
          }
          this.setupAccountShortcuts(document);
          if (this.accountShortcutCleanups.has(document)) {
            cleanup();
          }
        });
      });

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      win.addEventListener("unload", cleanup, { once: true });
      this.accountReadinessObservers.set(document, cleanup);

      // Cover the race where Favourite Folders finished while the observer
      // itself was being attached.
      this.setupAccountShortcuts(document);
      if (this.accountShortcutCleanups.has(document)) {
        cleanup();
      }
    }

    processDocument(document) {
      const tree = document?.getElementById?.("threadTree");
      if (!tree) {
        return;
      }
      this.injectStyle(document);
      tree
        .querySelectorAll("tr.card-layout")
        .forEach(row => this.updateCard(row, document));
      this.openDateGroups(document);
    }

    setupDocument(document) {
      const tree = document?.getElementById?.("threadTree");
      if (!tree) {
        this.waitForThreadTree(document);
        return;
      }
      this.pendingDocumentObservers.get(document)?.();
      if (this.observers.has(document)) {
        return;
      }

      // Group rows are populated asynchronously. Keep opening initial groups
      // briefly, then let the user collapse them normally for this session.
      this.groupExpansionDeadlines.set(document, Date.now() + 12000);
      this.setupScrollGuard(document, tree);
      this.ensureAccountShortcuts(document);
      this.processDocument(document);
      let pending = false;
      const observer = new document.defaultView.MutationObserver(() => {
        if (pending) {
          return;
        }
        pending = true;
        document.defaultView.requestAnimationFrame(() => {
          pending = false;
          this.processDocument(document);
        });
      });
      observer.observe(tree, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class", "data-properties"],
      });
      this.observers.set(document, observer);
    }

    waitForThreadTree(document) {
      if (
        !document?.documentElement ||
        !document.defaultView ||
        this.pendingDocumentObservers.has(document) ||
        this.observers.has(document)
      ) {
        return;
      }

      const url = document.URL || "";
      const windowType = document.documentElement.getAttribute("windowtype") || "";
      const isMailDocument =
        url.startsWith("about:3pane") ||
        url.includes("/messenger.xhtml") ||
        windowType === "mail:3pane";
      if (!isMailDocument) {
        return;
      }

      const win = document.defaultView;
      let cleanedUp = false;
      const observer = new win.MutationObserver(() => {
        if (!document.getElementById("threadTree")) {
          return;
        }
        cleanup();
        this.setupDocument(document);
      });
      const cleanup = () => {
        if (cleanedUp) {
          return;
        }
        cleanedUp = true;
        observer.disconnect();
        win.removeEventListener("unload", cleanup);
        if (this.pendingDocumentObservers.get(document) === cleanup) {
          this.pendingDocumentObservers.delete(document);
        }
      };

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      win.addEventListener("unload", cleanup, { once: true });
      this.pendingDocumentObservers.set(document, cleanup);

      // Cover the small race between the initial lookup and observer setup.
      if (document.getElementById("threadTree")) {
        cleanup();
        this.setupDocument(document);
      }
    }

    scanWindow(win) {
      const documents = new Set();
      const pending = [win?.document];
      let foundThreadTree = false;
      while (pending.length) {
        const document = pending.shift();
        if (!document || documents.has(document)) {
          continue;
        }
        documents.add(document);
        foundThreadTree ||= Boolean(document.getElementById?.("threadTree"));
        this.setupDocument(document);
        for (const element of document.querySelectorAll?.("browser, iframe") || []) {
          try {
            if (element.contentDocument && !documents.has(element.contentDocument)) {
              pending.push(element.contentDocument);
            }
          } catch (error) {}
        }
      }
      return foundThreadTree;
    }

    scanAllWindows() {
      let foundThreadTree = false;
      try {
        const windows = Services.wm.getEnumerator("mail:3pane");
        while (windows.hasMoreElements()) {
          const windowHasThreadTree = this.scanWindow(windows.getNext());
          foundThreadTree ||= windowHasThreadTree;
        }
      } catch (error) {
        this.log(`window scan failed: ${error}`);
      }
      return foundThreadTree;
    }

    watchOpenedWindow(openedWindow) {
      let win = openedWindow;
      try {
        win = openedWindow?.docShell?.domWindow || openedWindow;
      } catch (error) {}
      if (!win?.document) {
        return;
      }

      const scan = () => {
        if (this.started) {
          this.scanWindow(win);
        }
      };
      if (win.document.readyState === "complete") {
        scan();
      } else {
        win.addEventListener("load", scan, { once: true });
      }
    }

    scanUntilMailTreeReady() {
      if (this.scanAllWindows()) {
        return;
      }
      const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      timer.initWithCallback(
        {
          notify: () => {
            if (!this.started || this.scanAllWindows()) {
              timer.cancel();
              this.timers.delete(timer);
            }
          },
        },
        1000,
        Ci.nsITimer.TYPE_REPEATING_SLACK
      );
      this.timers.add(timer);
    }

    start() {
      if (this.started) {
        this.scanAllWindows();
        return;
      }
      this.started = true;
      for (const topic of this.topics) {
        Services.obs.addObserver(this.documentObserver, topic);
      }
      if (!this.windowListenerRegistered) {
        Services.wm.addListener(this.windowListener);
        this.windowListenerRegistered = true;
      }
      this.scanUntilMailTreeReady();
    }

    stop(isAppShutdown) {
      for (const topic of this.topics) {
        try {
          Services.obs.removeObserver(this.documentObserver, topic);
        } catch (error) {}
      }
      if (this.windowListenerRegistered) {
        try {
          Services.wm.removeListener(this.windowListener);
        } catch (error) {}
        this.windowListenerRegistered = false;
      }
      for (const observer of this.observers.values()) {
        observer.disconnect();
      }
      for (const cleanup of this.pendingDocumentObservers.values()) {
        cleanup();
      }
      for (const cleanup of this.scrollGuards.values()) {
        cleanup();
      }
      for (const cleanup of this.accountShortcutCleanups.values()) {
        cleanup();
      }
      for (const cleanup of this.accountReadinessObservers.values()) {
        cleanup();
      }
      for (const timer of this.timers) {
        timer.cancel();
      }
      this.observers.clear();
      this.pendingDocumentObservers.clear();
      this.scrollGuards.clear();
      this.accountShortcutCleanups.clear();
      this.accountReadinessObservers.clear();
      this.groupExpansionDeadlines.clear();
      this.timers.clear();
      this.started = false;

      if (!isAppShutdown) {
        Services.obs.notifyObservers(null, "startupcache-invalidate");
      }
    }
  }

  const controller = new PolishedUIController();

  this.PolishedUI = class extends ExtensionCommon.ExtensionAPI {
    onStartup() {
      controller.start();
    }

    getAPI() {
      return {
        PolishedUI: {
          start: async () => controller.start(),
        },
      };
    }

    onShutdown(isAppShutdown) {
      controller.stop(isAppShutdown);
    }
  };
}).call(this);
