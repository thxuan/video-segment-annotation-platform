// Independent save/recovery and legacy editor controls scenario, using explicit fixture dependencies.
const assert = require("node:assert/strict");
module.exports = async function checkSaveRecovery({
  page,
  start,
  endInput,
  until,
  root,
  getServer,
  getWrites,
  setFail,
  setAcceptDialogs,
}) {
  await start();
  await endInput().fill("3");
  await endInput().fill("3.5");
  await until(() => getWrites().length === 1 && getServer().revision === 8);
  await page.clock.runFor(1800);
  assert.equal(getWrites().length, 1);
  assert.equal(await endInput().inputValue(), "3.5");
  assert.equal(getWrites()[0].payload.expected_revision, 7);
  console.log(
    "PASS: debounced autosave sends one snapshot and adopts new revision",
  );

  setFail("503");
  await endInput().fill("4");
  await until(() => getWrites().length === 2);
  await page.getByRole("button", { name: "重试保存", exact: true }).waitFor();
  await page.clock.runFor(1800);
  assert.equal(getWrites().length, 2);
  assert.equal(await endInput().inputValue(), "4");
  await page.getByRole("button", { name: "重试保存", exact: true }).click();
  await until(() => getServer().revision === 9);
  console.log(
    "PASS: failed autosave pauses, retains input and retries with current revision",
  );

  await start();
  await page.getByLabel("片段 1 起点", { exact: true }).fill("10.");
  await page.clock.runFor(1800);
  assert.equal(getWrites().length, 0);
  await page.reload();
  await page.getByRole("button", { name: "恢复本机草稿" }).click();
  assert.equal(
    await page.getByLabel("片段 1 起点", { exact: true }).inputValue(),
    "10.",
  );
  await page.clock.runFor(1700);
  assert.equal(getWrites().length, 0);
  console.log(
    "PASS: incomplete input is not uploaded and survives refresh via explicit recovery",
  );

  await start();
  getServer().revision = 8;
  await endInput().fill("4");
  await until(() => getWrites().length === 1);
  await page.getByText("版本冲突，自动保存已暂停", { exact: false }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "恢复本机草稿" }).click();
  await page.getByText("本机草稿与服务端版本不同", { exact: false }).waitFor();
  assert.equal(await endInput().inputValue(), "4");
  let saved = await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith("annotation-draft-v1:"))
      .map((k) => JSON.parse(localStorage[k])),
  );
  assert(saved.some((s) => s.revision === 7));
  await page.reload();
  await page.getByRole("button", { name: "恢复本机草稿" }).click();
  await page.getByText("本机草稿与服务端版本不同", { exact: false }).waitFor();
  await page.clock.runFor(1700);
  assert.equal(getWrites().length, 1);
  console.log(
    "PASS: conflict recovery retains original revision across repeated refreshes and never overwrites",
  );

  await start();
  await page.getByLabel("自动保存（停止编辑 1.5 秒后）").uncheck();
  setFail("lost-submit");
  await page.getByRole("button", { name: "提交任务", exact: true }).click();
  await page
    .getByRole("button", { name: "重试相同提交", exact: true })
    .waitFor();
  assert(await endInput().isDisabled());
  assert.equal(getWrites().length, 1);
  await page.getByRole("button", { name: "重试相同提交", exact: true }).click();
  await page.getByText("已提交，片段只读。", { exact: false }).waitFor();
  assert.deepEqual(getWrites()[0].payload, getWrites()[1].payload);
  assert.equal(getServer().revision, 8);
  console.log(
    "PASS: lost submit response freezes edits and retries identical payload before read-only transition",
  );

  await start();
  await page.getByLabel("自动保存（停止编辑 1.5 秒后）").uncheck();
  await page.waitForFunction(
    () => document.querySelector("video").readyState >= 1,
  );
  const player = page.locator("video");
  const playerMs = () =>
    player.evaluate((v) => Math.round(v.currentTime * 1000));
  await player.evaluate((v) => {
    v.pause();
    v.currentTime = 10;
    v.focus();
  });
  await page.keyboard.press("ArrowRight");
  assert.equal(await playerMs(), 12565);
  await page.keyboard.press("Shift+ArrowRight");
  assert.equal(await playerMs(), 38215);
  await page.keyboard.press("Shift+ArrowLeft");
  assert.equal(await playerMs(), 12565);
  await page.keyboard.press("ArrowLeft");
  assert.equal(await playerMs(), 10000);
  await page.keyboard.down("Shift");
  await page.keyboard.down("ArrowRight");
  await page.keyboard.down("ArrowRight");
  await page.keyboard.up("ArrowRight");
  await page.keyboard.up("Shift");
  assert.equal(await playerMs(), 61300);
  await player.evaluate((v) => {
    v.currentTime = 10;
  });
  await player.evaluate((v) => v.dispatchEvent(new Event("timeupdate")));
  const playhead = page.getByLabel("视频播放位置", { exact: true });
  await playhead.focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await playerMs(), 10100);
  await page.keyboard.press("Shift+ArrowLeft");
  assert.equal(await playerMs(), 9600);
  await page.getByRole("region", { name: "片段时间轴", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await playerMs(), 9700);
  await page.keyboard.press("Shift+ArrowRight");
  assert.equal(await playerMs(), 10200);
  await page.locator("video").evaluate((v) => {
    v.pause();
    v.currentTime = 3;
    v.focus();
  });
  await page.keyboard.press("i");
  await page.locator("video").evaluate((v) => {
    v.currentTime = 4;
  });
  await playhead.focus();
  await page.keyboard.press("o");
  assert.equal(
    await page.getByLabel("片段 2 起点", { exact: true }).inputValue(),
    "3",
  );
  assert.equal(
    await page.getByLabel("片段 2 终点", { exact: true }).inputValue(),
    "4",
  );
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  assert.equal(
    await page.getByLabel("片段 2 起点", { exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "恢复撤销", exact: true }).click();
  await page.getByLabel("时间轴片段 2 终点", { exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.getByLabel("片段 2 终点", { exact: true }).inputValue(),
    "4.1",
  );
  await page.keyboard.press("Shift+ArrowLeft");
  assert.equal(
    await page.getByLabel("片段 2 终点", { exact: true }).inputValue(),
    "3.6",
  );
  await player.evaluate((v) => {
    v.currentTime = 6;
  });
  await page.getByRole("button", { name: "标记起点", exact: false }).focus();
  await page.keyboard.press("i");
  await player.evaluate((v) => {
    v.currentTime = 7;
  });
  await page
    .getByRole("button", { name: "标记终点并添加", exact: false })
    .focus();
  await page.keyboard.press("o");
  assert.equal(
    await page.getByLabel("片段 3 起点", { exact: true }).inputValue(),
    "6",
  );
  assert.equal(
    await page.getByLabel("片段 3 终点", { exact: true }).inputValue(),
    "7",
  );
  const startInput = page.getByLabel("片段 1 起点", { exact: true });
  await startInput.fill("");
  await page.keyboard.type("io");
  assert.equal(await startInput.inputValue(), "io");
  assert(
    await page
      .getByRole("button", { name: "标记终点并添加", exact: false })
      .isDisabled(),
  );
  await startInput.fill("1");
  await page.getByRole("button", { name: "聚焦所选片段", exact: true }).click();
  assert(
    Number(
      await page
        .getByLabel("视频播放位置", { exact: true })
        .getAttribute("max"),
    ) < getServer().duration_ms,
  );
  await page.screenshot({
    path: `${root}/.cache/step5-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({
    path: `${root}/.cache/step5-mobile.png`,
    fullPage: true,
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  assert.equal(overflow, false, "mobile horizontal overflow");
  console.log(
    "PASS: focused video 0.1%/1%, timeline 1/5 frames, I/O on media/sliders/buttons, native text input and mobile layout",
  );

  const restart = page.getByRole("button", { name: "重新标注", exact: true });
  setAcceptDialogs(false);
  await restart.click();
  assert.equal(await page.locator(".segment-row").count(), 3);
  setAcceptDialogs(true);
  await restart.click();
  assert.equal(await page.locator(".segment-row").count(), 0);
  assert.equal(getWrites().length, 0);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  assert.equal(await page.locator(".segment-row").count(), 3);
  assert.equal(
    await page.getByLabel("片段 2 终点", { exact: true }).inputValue(),
    "3.6",
  );
  await page.getByRole("button", { name: "恢复撤销", exact: true }).click();
  assert.equal(await page.locator(".segment-row").count(), 0);
  console.log(
    "PASS: restart confirmation cancels or clears all rows; undo restores rows and history redo does not insert an empty row",
  );

  await start("?role=admin");
  assert.equal(
    await page.getByRole("button", { name: "提交任务", exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "标记起点", exact: false }).count(),
    0,
  );
  assert.equal(getWrites().length, 0);
  console.log(
    "PASS: administrator preview remains read-only; no browser runtime errors",
  );
};
