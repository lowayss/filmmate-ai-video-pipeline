const {installVirtualCamera} = require("./virtual-camera-main.cjs");
const {installVisualCamera} = require("./virtual-camera-visual-main.cjs");
const {installVirtualCameraBlockout} = require("./virtual-camera-blockout-main.cjs");
installVirtualCamera();
installVisualCamera();
installVirtualCameraBlockout();
require("./main.cjs");
