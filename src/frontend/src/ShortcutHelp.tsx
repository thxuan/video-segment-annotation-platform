export function ShortcutHelp({
  editable,
  context,
}: {
  editable: boolean;
  context: "video" | "timeline";
}) {
  const common = editable
    ? [
        ["Space", "播放 / 暂停"],
        ["I", "标记起点"],
        ["O", "确认终点"],
        ["Alt / ⌥ + X", "取消未完成选段"],
        ["Ctrl / ⌘ + S", "保存"],
        ["Ctrl / ⌘ + Z", "撤销"],
      ]
    : [["Space", "播放 / 暂停"]];
  return (
    <div className="shortcut-groups">
      <section aria-label="常用快捷键">
        <div className="shortcut-heading">
          <h3>常用操作</h3>
          <span>
            <kbd>Esc</kbd> 退出全屏
          </span>
        </div>
        <dl className="shortcut-common">
          {common.map(([keys, label]) => (
            <div key={keys}>
              <dt>
                <kbd>{keys}</kbd>
              </dt>
              <dd>{label}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section aria-label="方向键快捷键">
        <h3>方向键步长</h3>
        <table className="shortcut-navigation">
          <thead>
            <tr>
              <th scope="col">操作位置</th>
              <th scope="col">
                <kbd>← / →</kbd>
              </th>
              <th scope="col">
                <kbd>Shift</kbd> + <kbd>← / →</kbd>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              className={context === "video" ? "shortcut-context-active" : ""}
            >
              <th scope="row">播放器 / 页面</th>
              <td>全片 0.1%</td>
              <td>全片 1%</td>
            </tr>
            <tr
              className={
                context === "timeline" ? "shortcut-context-active" : ""
              }
            >
              <th scope="row">时间轴</th>
              <td>1 帧</td>
              <td>5 帧</td>
            </tr>
          </tbody>
        </table>
      </section>
      {editable && (
        <details className="shortcut-extra">
          <summary>选段规则</summary>
          <ul>
            <li>片段内按 I：重新标记该片段；空白处按 I：新建。</li>
            <li>按 O 确认后才应用；重叠时保留原片段，调整后再按 O。</li>
            <li>Alt / Option + X 只取消未完成选段，保留已确认片段。</li>
          </ul>
        </details>
      )}
      <details className="shortcut-extra">
        <summary>更多快捷键与输入说明</summary>
        {editable && (
          <dl className="shortcut-more">
            <div>
              <dt>
                <kbd>Shift + I / O</kbd>
              </dt>
              <dd>跳到起点 / 终点</dd>
            </div>
            <div>
              <dt>
                <kbd>Ctrl / ⌘ + Shift + Z</kbd>
                <span> 或 </span>
                <kbd>Ctrl + Y</kbd>
              </dt>
              <dd>恢复撤销</dd>
            </div>
          </dl>
        )}
        <p>
          {editable
            ? "文字输入框保留输入与原生撤销；Ctrl / ⌘ + S 仍可保存。"
            : "输入和音量、倍速控件保留自身的键盘操作。"}
          空格始终只播放 / 暂停视频，按钮用 Enter 或点击操作。
        </p>
        {editable && (
          <p>
            Shift + I
            优先定位待完成起点，其次是所选片段起点。“重新标注”确认后清空片段，可撤销。
          </p>
        )}
      </details>
    </div>
  );
}
