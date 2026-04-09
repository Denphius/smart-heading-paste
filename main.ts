import {
  Plugin,
  Editor,
  MarkdownView,
  Notice,
  PluginSettingTab,
  Setting,
  App
} from 'obsidian';

// ==================== 设置接口 ====================
interface SmartPasteSettings {
  // 当没有上下文标题时，是否强制将 H1 转为 H2（避免与文档标题冲突）
  avoidH1WhenNoContext: boolean;
  // 是否显示粘贴调整提示
  showNotification: boolean;
  // 最大允许标题级别（1-6，通常保持 6）
  maxHeadingLevel: number;
  // 是否保留代码块内的标题（# 在代码块中通常是注释而非标题）
  skipCodeBlocks: boolean;
}

const DEFAULT_SETTINGS: SmartPasteSettings = {
  avoidH1WhenNoContext: true,
  showNotification: true,
  maxHeadingLevel: 6,
  skipCodeBlocks: true,
};

// ==================== 主插件类 ====================
export default class SmartHeadingPastePlugin extends Plugin {
  settings: SmartPasteSettings;

  async onload() {
    await this.loadSettings();

    console.log('Smart Heading Paste 插件已加载');

    // 注册编辑器粘贴事件拦截
    this.registerEvent(
      this.app.workspace.on('editor-paste', this.handlePaste)
    );

    // 添加设置面板
    this.addSettingTab(new SmartPasteSettingTab(this.app, this));

    // 添加手动触发命令（备用）
    this.addCommand({
      id: 'smart-paste-command',
      name: '智能粘贴（调整标题层级）',
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'v' }],
      editorCallback: (editor: Editor) => {
        this.manualSmartPaste(editor);
      }
    });
  }

  onunload() {
    console.log('Smart Heading Paste 插件已卸载');
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ==================== 核心粘贴处理器 ====================
  private handlePaste = (event: ClipboardEvent, editor: Editor, view: MarkdownView) => {
    // 如果其他插件已经处理了粘贴事件，不重复拦截
    if (event.defaultPrevented) {
      console.log('Smart Heading Paste: paste event already handled by another plugin');
      return;
    }

    const clipboardData = event.clipboardData;
    if (!clipboardData) return;

    const pastedText = clipboardData.getData('text/plain');

    // 快速检查：是否包含 Markdown 标题
    if (!this.containsMarkdownHeadings(pastedText)) {
      return; // 让默认逻辑处理
    }

    // 阻止默认粘贴
    event.preventDefault();
    event.stopPropagation();

    const cursor = editor.getCursor();

    console.log('Smart Heading Paste: intercepting paste');

    // 执行智能调整
    this.performSmartPaste(editor, pastedText, cursor.line);
  };

  // ==================== 手动智能粘贴 ====================
  private async manualSmartPaste(editor: Editor) {
    try {
      const text = await navigator.clipboard.readText();
      if (!this.containsMarkdownHeadings(text)) {
        editor.replaceSelection(text);
        return;
      }
      const cursor = editor.getCursor();
      this.performSmartPaste(editor, text, cursor.line);
    } catch (err) {
      new Notice('无法读取剪贴板内容');
    }
  }

  // ==================== 核心逻辑 ====================
  private performSmartPaste(editor: Editor, content: string, currentLine: number) {
    // 1. 获取上下文标题级别
    const contextLevel = this.getContextHeadingLevel(editor, currentLine);

    // 2. 解析粘贴内容
    const parsed = this.parseHeadings(content);
    if (!parsed.hasHeading) {
      editor.replaceSelection(content);
      return;
    }

    // 3. 计算目标层级
    let targetBaseLevel: number;

    if (contextLevel === 0) {
      // 无上下文：根据设置决定是否避免 H1
      targetBaseLevel = this.settings.avoidH1WhenNoContext ? 2 : 1;
    } else {
      // 有上下文：必须为上下文级别 + 1
      targetBaseLevel = contextLevel + 1;
    }

    // 确保目标级别合法
    targetBaseLevel = Math.max(1, Math.min(this.settings.maxHeadingLevel, targetBaseLevel));

    // 4. 计算偏移量
    const offset = targetBaseLevel - parsed.minLevel;

    // 5. 生成调整后的内容
    const adjustedContent = this.applyHeadingOffset(
      content,
      offset,
      this.settings.skipCodeBlocks
    );

    // 6. 插入内容
    editor.replaceSelection(adjustedContent);

    // 7. 通知用户
    if (this.settings.showNotification) {
      const contextStr = contextLevel === 0 ? '文档根' : `H${contextLevel}`;
      const details = offset === 0
        ? '无需调整'
        : `偏移 ${offset > 0 ? '+' : ''}${offset} 级`;
      new Notice(`粘贴调整: ${contextStr} → H${targetBaseLevel} (${details})`, 3000);
    }
  }

  // ==================== 工具方法 ====================

  /**
   * 检查文本是否包含 Markdown 标题（排除代码块）
   */
  private containsMarkdownHeadings(text: string): boolean {
    const lines = text.split('\n');
    let inCodeBlock = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // 切换代码块状态
      if (trimmed.startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }

      // 只检查非代码块内的标题
      if (!inCodeBlock && /^#{1,6}\s+/.test(line)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 获取当前光标所在位置的上下文标题级别
   * 向上查找最近的标题（1-6），没找到返回 0
   */
  private getContextHeadingLevel(editor: Editor, currentLine: number): number {
    // 先计算到 currentLine 为止，文档中未闭合的代码块深度
    let fenceCount = 0;
    for (let i = 0; i <= currentLine; i++) {
      const trimmed = editor.getLine(i).trim();
      if (trimmed.startsWith('```')) {
        fenceCount++;
      }
    }

    // 如果 fenceCount 为奇数，说明 currentLine 处于一个未闭合的代码块内部
    let inCodeBlock = (fenceCount % 2 === 1);

    // 从当前行向上查找
    for (let i = currentLine; i >= 0; i--) {
      const line = editor.getLine(i);
      const trimmed = line.trim();

      // 代码块边界：向上翻越时状态翻转
      if (trimmed.startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }

      // 如果在代码块内，跳过标题检测
      if (inCodeBlock) continue;

      // 匹配标题
      const match = line.match(/^(#{1,6})\s+/);
      if (match) {
        return match[1].length;
      }
    }

    return 0; // 无上下文
  }

  /**
   * 解析粘贴内容中的标题信息
   */
  private parseHeadings(content: string): {
    hasHeading: boolean;
    minLevel: number;
    maxLevel: number;
    headings: Array<{line: number; level: number; text: string}>;
  } {
    const lines = content.split('\n');
    let inCodeBlock = false;
    let minLevel = 6;
    let maxLevel = 1;
    let hasHeading = false;
    const headings = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // 代码块边界检测
      if (trimmed.startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }

      // 解析标题（支持代码块内标题根据设置决定是否处理）
      if (!inCodeBlock || !this.settings.skipCodeBlocks) {
        const match = line.match(/^(#{1,6})\s+(.*)$/);
        if (match) {
          const level = match[1].length;
          hasHeading = true;
          minLevel = Math.min(minLevel, level);
          maxLevel = Math.max(maxLevel, level);
          headings.push({ line: i, level, text: match[2] });
        }
      }
    }

    return { hasHeading, minLevel, maxLevel, headings };
  }

  /**
   * 应用标题偏移量
   * @param offset 正数增加 #，负数减少 #
   * @param skipCodeBlocks 是否跳过代码块内的标题
   */
  private applyHeadingOffset(content: string, offset: number, skipCodeBlocks: boolean): string {
    if (offset === 0) return content;

    const lines = content.split('\n');
    let inCodeBlock = false;

    return lines.map(line => {
      const trimmed = line.trim();

      // 代码块边界
      if (trimmed.startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        return line;
      }

      // 如果在代码块内且设置为跳过，则不处理
      if (inCodeBlock && skipCodeBlocks) return line;

      // 匹配标题
      const match = line.match(/^(\s*)(#{1,6})(\s+.*)$/);
      if (match) {
        const indent = match[1];
        const currentLevel = match[2].length;
        const content = match[3];

        // 计算新级别
        let newLevel = currentLevel + offset;

        // 边界限制
        newLevel = Math.max(1, Math.min(this.settings.maxHeadingLevel, newLevel));

        return indent + '#'.repeat(newLevel) + content;
      }

      return line;
    }).join('\n');
  }
}

// ==================== 设置面板 ====================
class SmartPasteSettingTab extends PluginSettingTab {
  plugin: SmartHeadingPastePlugin;

  constructor(app: App, plugin: SmartHeadingPastePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: '智能粘贴设置' });

    // 设置1：无上下文时避免 H1
    new Setting(containerEl)
      .setName('避免文档根级别 H1')
      .setDesc('当粘贴位置没有上级标题时，自动将 H1 转为 H2（避免与文档标题冲突）')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.avoidH1WhenNoContext)
        .onChange(async (value) => {
          this.plugin.settings.avoidH1WhenNoContext = value;
          await this.plugin.saveSettings();
        }));

    // 设置2：显示通知
    new Setting(containerEl)
      .setName('显示调整提示')
      .setDesc('粘贴后显示标题层级调整详情')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showNotification)
        .onChange(async (value) => {
          this.plugin.settings.showNotification = value;
          await this.plugin.saveSettings();
        }));

    // 设置3：跳过代码块
    new Setting(containerEl)
      .setName('跳过代码块')
      .setDesc('不调整代码块内的 # 字符（如 Python 注释、Shell 配置）')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.skipCodeBlocks)
        .onChange(async (value) => {
          this.plugin.settings.skipCodeBlocks = value;
          await this.plugin.saveSettings();
        }));

    // 设置4：最大标题级别
    new Setting(containerEl)
      .setName('最大标题级别')
      .setDesc('限制标题最高级别（通常保持 6）')
      .addSlider(slider => slider
        .setLimits(1, 6, 1)
        .setValue(this.plugin.settings.maxHeadingLevel)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.maxHeadingLevel = value;
          await this.plugin.saveSettings();
        }));
  }
}
