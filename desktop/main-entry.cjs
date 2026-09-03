const {installVirtualCamera} = require("./virtual-camera-main.cjs");
const {installVisualCamera} = require("./virtual-camera-visual-main.cjs");
const {installVirtualCameraStage} = require("./virtual-camera-stage-main.cjs");
installVirtualCamera();
installVisualCamera();
installVirtualCameraStage();
require("./main.cjs");
