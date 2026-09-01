from pathlib import Path

path = Path("desktop/main.cjs")
text = path.read_text(encoding="utf-8")
old = '''ipcMain.handle("production-agent:run", async (_event, project, scene, request = {}) => {
  return await pythonBridge.runProductionAgentAsync(productionAgentPayload(project, scene, {...request, action:"plan"}));
});
'''
new = '''ipcMain.handle("production-agent:run", async (_event, project, scene, request = {}) => {
  return await pythonBridge.runProductionAgentAsync(productionAgentPayload(project, scene, {
    action:"plan",
    goal:request?.goal,
    target:request?.target,
    previous_checkpoint:request?.previous_checkpoint,
  }));
});
'''
if text.count(old) != 1:
    raise SystemExit(f"expected one Production Agent run handler, found {text.count(old)}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print("preserved explicit previous_checkpoint contract")
