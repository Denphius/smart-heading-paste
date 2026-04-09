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

// Web/chat copied text may contain invisible prefix chars before '#'.
// We normalize these chars so heading matching remains stable.
const LEADING_NOISE_RE = /^[\s\p{Cf}\p{Zs}]*/u;
// Keep detection and parsing aligned to avoid false "no heading" results.
// Some copy sources may inject zero-width chars or omit the usual space after '#'.
const HEADING_LEVEL_FROM_START_RE = /^(#{1,6}|＃{1,6})(?:[\s\p{Cf}\p{Zs}]|$)/u;
const HEADING_PARSE_RE = /^([\s\p{Cf}\p{Zs}]*)((?:#{1,6}|＃{1,6}))(.*)$/u;

// ==================== 主插件类 ====================
export default class SmartHeadingPastePlugin extends Plugin {
  settings: SmartPasteSettings;
  private lastPastedText = '';
  private lastPasteTime = 0;

  async onload() {
    await this.loadSettings();

    console.log('Smart Heading Paste 插件已加载');

    // 注册编辑器粘贴事件拦截
    this.registerEvent(
      this.app.workspace.on('editor-paste', this.handlePaste)
    );

    // DOM paste 兜底：某些场景下 editor-paste 可能不稳定
    this.registerDomEvent(document, 'paste', this.handleDomPaste);

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
    this.processPasteEvent(event, editor, 'editor-paste');
  };

  private handleDomPaste = (event: ClipboardEvent) => {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView) return;

    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return;
    if (!activeElement.closest('.markdown-source-view, .cm-editor, .cm-content')) return;

    this.processPasteEvent(event, activeView.editor, 'dom-paste');
  };

  private processPasteEvent(event: ClipboardEvent, editor: Editor, source: 'editor-paste' | 'dom-paste') {
    // 即使其他插件已标记 defaultPrevented，也继续尝试识别并处理，
    // 避免在某些编辑模式中错过真正的粘贴内容。
    if (event.defaultPrevented) {
      console.log(`Smart Heading Paste (${source}): paste marked handled, still checking`);
    }

    const clipboardData = event.clipboardData;
    if (!clipboardData) return;

    const pastedText = clipboardData.getData('text/plain');
    if (!pastedText) return;

    const now = Date.now();

    // 防抖去重：多个事件源可能在同一次粘贴中重复触发
    if (pastedText === this.lastPastedText && now - this.lastPasteTime < 250) {
      event.preventDefault();
      event.stopPropagation();
      console.log(`Smart Heading Paste (${source}): deduping duplicate paste event`);
      return;
    }

    // 快速检查：是否包含 Markdown 标题
    if (!this.containsMarkdownHeadings(pastedText)) {
      return; // 无标题则让默认粘贴继续
    }

    // 阻止默认粘贴
    event.preventDefault();
    event.stopPropagation();

    this.lastPastedText = pastedText;
    this.lastPasteTime = now;

    console.log(`Smart Heading Paste (${source}): intercepting paste`);

    const cursor = editor.getCursor();

    // 执行智能调整
    this.performSmartPaste(editor, pastedText, cursor.line);
  }

  // ==================== 手动智能粘贴 ====================
  private async manualSmartPaste(editor: Editor) {
    try {
      const text = await navigator.clipboard.readText();
      console.log('[Smart Heading Paste] 手动粘贴触发');
      if (!this.containsMarkdownHeadings(text)) {
        console.log('[Smart Heading Paste] 手动粘贴内容无标题，直接插入');
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
    console.log(`[Smart Heading Paste] 上文标题层级: ${contextLevel === 0 ? '无 (文档根)' : 'H' + contextLevel}`);

    // 2. 解析粘贴内容
    const parsed = this.parseHeadings(content);
    if (!parsed.hasHeading) {
      console.log('[Smart Heading Paste] 粘贴内容无标题，直接插入');
      editor.replaceSelection(content);
      return;
    }
    console.log(`[Smart Heading Paste] 粘贴内容标题统计: 最小H${parsed.minLevel}, 最大H${parsed.maxLevel}, 共${parsed.headings.length}个标题`);

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
    console.log(`[Smart Heading Paste] 目标层级: H${targetBaseLevel}, 原始最小层级: H${parsed.minLevel}, 偏移量: ${offset > 0 ? '+' : ''}${offset}`);

    // 5. 生成调整后的内容
    const adjustedContent = this.applyHeadingOffset(
      content,
      offset,
      this.settings.skipCodeBlocks
    );

    const hasModified = adjustedContent !== content;
    console.log(`[Smart Heading Paste] 是否做了修改: ${hasModified ? '是' : '否'}`);

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
    const lines = text.split(/\r\n|\r|\n/);
    let inCodeBlock = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // 切换代码块状态
      if (trimmed.startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }

      // 只检查非代码块内的标题（允许前导空格，因为网页复制来的文本常有缩进）
      if (!inCodeBlock && this.extractHeadingLevel(line) > 0) {
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

      // 匹配标题（允许前导空格）
      const level = this.extractHeadingLevel(line);
      if (level > 0) {
        console.log(`[Smart Heading Paste] 找到上文标题: H${level} at line ${i + 1}: ${line.trim()}`);
        return level;
      }
    }

    console.log('[Smart Heading Paste] 未找到上文标题，返回文档根');
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
    const lines = content.split(/\r\n|\r|\n/);
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
        const parsedLine = this.parseHeadingLine(line);
        if (parsedLine) {
          const level = parsedLine.level;
          hasHeading = true;
          minLevel = Math.min(minLevel, level);
          maxLevel = Math.max(maxLevel, level);
          headings.push({ line: i, level, text: parsedLine.content.trim() });
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
    if (offset === 0) {
      console.log('[Smart Heading Paste] applyHeadingOffset: 偏移量为0，无需调整');
      return content;
    }

    const lines = content.split(/\r\n|\r|\n/);
    let inCodeBlock = false;

    return lines.map((line, index) => {
      const trimmed = line.trim();

      // 代码块边界
      if (trimmed.startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        return line;
      }

      // 如果在代码块内且设置为跳过，则不处理
      if (inCodeBlock && skipCodeBlocks) return line;

      // 匹配标题
      const parsedLine = this.parseHeadingLine(line);
      if (parsedLine) {
        const indent = parsedLine.prefix;
        const currentLevel = parsedLine.level;
        const content = parsedLine.content;

        // 计算新级别
        let newLevel = currentLevel + offset;

        // 边界限制
        newLevel = Math.max(1, Math.min(this.settings.maxHeadingLevel, newLevel));

        const result = indent + '#'.repeat(newLevel) + content;
        console.log(`[Smart Heading Paste] 调整第${index + 1}行: H${currentLevel} -> H${newLevel} | ${result.trim()}`);
        return result;
      }

      return line;
    }).join('\n');
  }

  /**
   * 从行首提取 ATX 标题级别（1-6），无法识别返回 0
   */
  private extractHeadingLevel(line: string): number {
    const normalized = line.replace(LEADING_NOISE_RE, '');
    const match = normalized.match(HEADING_LEVEL_FROM_START_RE);
    return match ? match[1].replace(/＃/g, '#').length : 0;
  }

  /**
   * 解析一行标题，返回前缀、级别和标题正文
   */
  private parseHeadingLine(line: string): { prefix: string; level: number; content: string } | null {
    const match = line.match(HEADING_PARSE_RE);
    if (!match) return null;

    const rest = match[3] ?? '';
    // If there is trailing content, it should start with whitespace/noise to be
    // treated as ATX heading text; empty trailing content (e.g. "###") is valid.
    if (rest.length > 0 && !/^[\s\p{Cf}\p{Zs}]/u.test(rest)) {
      return null;
    }

    return {
      prefix: match[1],
      level: match[2].replace(/＃/g, '#').length,
      content: rest,
    };
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
