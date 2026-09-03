const {installVirtualCamera} = require("./virtual-camera-main.cjs");
const {installVisualCamera} = require("./virtual-camera-visual-main.cjs");
installVirtualCamera();
installVisualCamera();
require("./main.cjs");
