import {
  Plugin,
  Notice,
  Platform,
  FileSystemAdapter,
} from "obsidian";
import { randomUUID } from "node:crypto";

import { RpcRouter } from "./rpc-router";
import { ToolRegistry } from "./tools-registry";
import { IdeWsServer } from "./ws-server";
import { LockfileManager } from "./lockfile";
import { StatusBar } from "./status-bar";
import { registerMcpHandshake } from "./mcp-handshake";
import { ObsidianContext } from "./obsidian-context";
import { registerEditorTools } from "./handlers/editors";
import { registerFileTools } from "./handlers/files";
import { registerStubTools } from "./handlers/stubs";
import { registerDiffTools } from "./handlers/diff";
import { registerObsidianTools } from "./handlers/obsidian-tools";
import { DIFF_VIEW_TYPE, DiffView } from "./views/diff-view";
// SelectionNotifier is intentionally NOT wired up in v0.1.0 — the push
// surfaced selections at unwanted moments and added noise. Source kept
// in src/notifier.ts for future re-enable.
// import { SelectionNotifier } from "./notifier";
import {
  ClaudeCodeIdeSettings,
  ClaudeCodeIdeSettingTab,
  DEFAULT_SETTINGS,
} from "./settings";

export default class ClaudeCodeIdePlugin extends Plugin {
  settings: ClaudeCodeIdeSettings = DEFAULT_SETTINGS;
  private server?: IdeWsServer;
  private lockfile?: LockfileManager;
  private statusBar?: StatusBar;
  private authToken = "";
  private vaultRoot = "";

  async onload(): Promise<void> {
    if (!Platform.isDesktopApp) {
      new Notice("Claude Code IDE: desktop-only plugin");
      return;
    }

    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice("Claude Code IDE: vault adapter is not a filesystem");
      return;
    }
    this.vaultRoot = adapter.getBasePath();

    await this.loadSettings();
    this.addSettingTab(new ClaudeCodeIdeSettingTab(this.app, this));

    const statusEl = this.addStatusBarItem();
    this.statusBar = new StatusBar(statusEl);

    this.authToken = randomUUID();

    const ctx = new ObsidianContext(this.app, this.vaultRoot);
    const router = new RpcRouter();
    const tools = new ToolRegistry();

    this.registerView(DIFF_VIEW_TYPE, (leaf) => new DiffView(leaf));

    registerMcpHandshake(router, tools);
    registerEditorTools(tools, ctx);
    registerFileTools(tools, ctx);
    registerDiffTools(tools, ctx);
    registerObsidianTools(tools, ctx, () => this.settings);
    registerStubTools(tools);

    this.lockfile = new LockfileManager("Obsidian", [this.vaultRoot]);

    this.server = new IdeWsServer(router, this.authToken, {
      onListening: (port) => {
        this.lockfile?.write(port, this.authToken);
        this.statusBar?.setListening(port);
        console.log(
          `[claude-code-ide] listening on 127.0.0.1:${port}, ` +
            `lockfile=${this.lockfile?.getCurrentPath()}, ` +
            `tools=${tools.list().length}`,
        );
      },
      onConnect: () => {
        const port = this.server?.getPort() ?? 0;
        const n = this.server?.clientCount() ?? 0;
        this.statusBar?.setConnected(port, n);
      },
      onDisconnect: () => {
        const port = this.server?.getPort() ?? 0;
        const n = this.server?.clientCount() ?? 0;
        if (n === 0) this.statusBar?.setListening(port);
        else this.statusBar?.setConnected(port, n);
      },
      onError: (err) => console.error("[claude-code-ide] server error", err),
    });

    try {
      await this.server.start();
    } catch (err) {
      console.error("[claude-code-ide] failed to start server", err);
      new Notice("Claude Code IDE: failed to start (see console)");
      this.statusBar?.setOff();
      return;
    }
  }

  async onunload(): Promise<void> {
    try {
      this.lockfile?.cleanup();
    } catch (err) {
      console.error("[claude-code-ide] lockfile cleanup error", err);
    }
    try {
      await this.server?.stop();
    } catch (err) {
      console.error("[claude-code-ide] server stop error", err);
    }
    this.statusBar?.setOff();
    console.log("[claude-code-ide] unloaded");
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<ClaudeCodeIdeSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // Used by the settings tab to show "WebSocket: listening :PORT".
  connectionInfo(): string {
    if (!this.server) return "(not started)";
    const port = this.server.getPort();
    const clients = this.server.clientCount();
    return `127.0.0.1:${port}${clients ? `, ${clients} client(s)` : ""}`;
  }
}
