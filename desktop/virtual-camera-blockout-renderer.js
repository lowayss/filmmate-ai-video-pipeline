(() => {
  const M = window.FilmMateBlockoutMath;
  if (!M) return;

  function multiply(a,b){
    const out=new Float32Array(16);
    for(let column=0;column<4;column++){
      for(let row=0;row<4;row++){
        out[column*4+row]=a[0*4+row]*b[column*4+0]+a[1*4+row]*b[column*4+1]+a[2*4+row]*b[column*4+2]+a[3*4+row]*b[column*4+3];
      }
    }
    return out;
  }
  function perspective(fovDegrees,aspect,near=0.05,far=100){
    const f=1/Math.tan((Number(fovDegrees)||50)*Math.PI/360),nf=1/(near-far);
    return new Float32Array([f/aspect,0,0,0,0,f,0,0,0,0,(far+near)*nf,-1,0,0,2*far*near*nf,0]);
  }
  function lookAt(eye,target,up){
    let z=M.normalize3?M.normalize3(M.sub3(eye,target)):null;
    if(!z){const d=M.sub3(eye,target),n=Math.hypot(...d)||1;z=d.map(v=>v/n);}
    const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const norm=v=>{const n=Math.hypot(...v)||1;return v.map(x=>x/n);};
    const x=norm(cross(up,z)),y=cross(z,x);
    return new Float32Array([
      x[0],y[0],z[0],0,
      x[1],y[1],z[1],0,
      x[2],y[2],z[2],0,
      -x[0]*eye[0]-x[1]*eye[1]-x[2]*eye[2],
      -y[0]*eye[0]-y[1]*eye[1]-y[2]*eye[2],
      -z[0]*eye[0]-z[1]*eye[1]-z[2]*eye[2],1,
    ]);
  }
  function modelMatrix(object){
    const p=object.position||[0,0,0],s=object.size||[1,1,1],a=(Number(object.rotation_y)||0)*Math.PI/180,c=Math.cos(a),n=Math.sin(a);
    return new Float32Array([
      c*s[0],0,-n*s[0],0,
      0,s[1],0,0,
      n*s[2],0,c*s[2],0,
      p[0],p[1],p[2],1,
    ]);
  }
  function compile(gl,type,source){
    const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){const error=gl.getShaderInfoLog(shader);gl.deleteShader(shader);throw new Error(error||"shader_compile_failed");}
    return shader;
  }
  function program(gl){
    const vertex=compile(gl,gl.VERTEX_SHADER,"attribute vec3 aPosition;uniform mat4 uMvp;void main(){gl_Position=uMvp*vec4(aPosition,1.0);}");
    const fragment=compile(gl,gl.FRAGMENT_SHADER,"precision mediump float;uniform vec3 uColor;void main(){gl_FragColor=vec4(uColor,1.0);}");
    const p=gl.createProgram();gl.attachShader(p,vertex);gl.attachShader(p,fragment);gl.linkProgram(p);gl.deleteShader(vertex);gl.deleteShader(fragment);
    if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p)||"program_link_failed");return p;
  }
  const CUBE=new Float32Array([
    -0.5,-0.5,0.5, 0.5,-0.5,0.5, 0.5,0.5,0.5, -0.5,-0.5,0.5, 0.5,0.5,0.5, -0.5,0.5,0.5,
    0.5,-0.5,-0.5, -0.5,-0.5,-0.5, -0.5,0.5,-0.5, 0.5,-0.5,-0.5, -0.5,0.5,-0.5, 0.5,0.5,-0.5,
    -0.5,-0.5,-0.5, -0.5,-0.5,0.5, -0.5,0.5,0.5, -0.5,-0.5,-0.5, -0.5,0.5,0.5, -0.5,0.5,-0.5,
    0.5,-0.5,0.5, 0.5,-0.5,-0.5, 0.5,0.5,-0.5, 0.5,-0.5,0.5, 0.5,0.5,-0.5, 0.5,0.5,0.5,
    -0.5,0.5,0.5, 0.5,0.5,0.5, 0.5,0.5,-0.5, -0.5,0.5,0.5, 0.5,0.5,-0.5, -0.5,0.5,-0.5,
    -0.5,-0.5,-0.5, 0.5,-0.5,-0.5, 0.5,-0.5,0.5, -0.5,-0.5,-0.5, 0.5,-0.5,0.5, -0.5,-0.5,0.5,
  ]);
  function gridVertices(size=10,step=1){const rows=[];for(let i=-size;i<=size;i+=step){rows.push(-size,0,i,size,0,i,i,0,-size,i,0,size);}return new Float32Array(rows);}
  function frustumVertices(pose){
    const position=pose.position||[0,1.6,5],q=pose.orientation||[0,0,0,1],depth=0.8,halfW=0.42,halfH=0.24;
    const local=[[0,0,0],[-halfW,-halfH,-depth],[halfW,-halfH,-depth],[halfW,halfH,-depth],[-halfW,halfH,-depth]];
    const world=local.map(point=>M.add3(position,M.quatRotateVector(q,point)));
    const rows=[];for(let i=1;i<=4;i++)rows.push(...world[0],...world[i]);for(let i=1;i<=4;i++)rows.push(...world[i],...world[i===4?1:i+1]);return new Float32Array(rows);
  }

  class BlockoutRenderer{
    constructor(canvas){
      this.canvas=canvas;this.gl=canvas.getContext("webgl",{antialias:true,alpha:false});
      if(!this.gl)throw new Error("WebGL을 사용할 수 없습니다.");
      const gl=this.gl;this.program=program(gl);this.positionLoc=gl.getAttribLocation(this.program,"aPosition");this.mvpLoc=gl.getUniformLocation(this.program,"uMvp");this.colorLoc=gl.getUniformLocation(this.program,"uColor");
      this.cubeBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.cubeBuffer);gl.bufferData(gl.ARRAY_BUFFER,CUBE,gl.STATIC_DRAW);
      this.grid=gridVertices();this.gridBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.gridBuffer);gl.bufferData(gl.ARRAY_BUFFER,this.grid,gl.STATIC_DRAW);
      this.dynamicBuffer=gl.createBuffer();gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.enable(gl.SCISSOR_TEST);
      this.state={objects:[],camera:{position:[0,1.6,5],orientation:[0,0,0,1],fov:50},path:[],selectedId:null};
    }
    setState(state){this.state={...this.state,...state};this.render();}
    resize(){
      const ratio=Math.min(2,window.devicePixelRatio||1),width=Math.max(320,Math.floor(this.canvas.clientWidth*ratio)),height=Math.max(220,Math.floor(this.canvas.clientHeight*ratio));
      if(this.canvas.width!==width||this.canvas.height!==height){this.canvas.width=width;this.canvas.height=height;}
    }
    drawBuffer(buffer,count,mode,mvp,color){
      const gl=this.gl;gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.enableVertexAttribArray(this.positionLoc);gl.vertexAttribPointer(this.positionLoc,3,gl.FLOAT,false,0,0);gl.uniformMatrix4fv(this.mvpLoc,false,mvp);gl.uniform3fv(this.colorLoc,color);gl.drawArrays(mode,0,count);
    }
    drawDynamic(vertices,mode,mvp,color){
      if(!vertices?.length)return;const gl=this.gl;gl.bindBuffer(gl.ARRAY_BUFFER,this.dynamicBuffer);gl.bufferData(gl.ARRAY_BUFFER,vertices,gl.DYNAMIC_DRAW);gl.enableVertexAttribArray(this.positionLoc);gl.vertexAttribPointer(this.positionLoc,3,gl.FLOAT,false,0,0);gl.uniformMatrix4fv(this.mvpLoc,false,mvp);gl.uniform3fv(this.colorLoc,color);gl.drawArrays(mode,0,vertices.length/3);
    }
    renderScene(projection,view,{observer=false}={}){
      const gl=this.gl,base=multiply(projection,view);this.drawBuffer(this.gridBuffer,this.grid.length/3,gl.LINES,base,[0.22,0.26,0.3]);
      for(const object of this.state.objects||[]){
        const selected=object.id===this.state.selectedId;const palette=selected?[0.72,1,0.34]:object.type==="actor"?[0.35,0.65,0.96]:object.type==="wall"?[0.5,0.52,0.56]:[0.82,0.58,0.32];
        const mvp=multiply(base,modelMatrix(object));this.drawBuffer(this.cubeBuffer,CUBE.length/3,gl.TRIANGLES,mvp,palette);
      }
      if(observer){
        const path=(this.state.path||[]).flatMap(point=>point.position||point);if(path.length>=6)this.drawDynamic(new Float32Array(path),gl.LINE_STRIP,base,[0.72,1,0.34]);
        this.drawDynamic(frustumVertices(this.state.camera),gl.LINES,base,[1,0.88,0.36]);
      }
    }
    render(){
      this.resize();const gl=this.gl,w=this.canvas.width,h=this.canvas.height,left=Math.floor(w*0.68),right=w-left;gl.useProgram(this.program);
      gl.scissor(0,0,w,h);gl.clearColor(0.035,0.045,0.055,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      const camera=this.state.camera||{},position=camera.position||[0,1.6,5],orientation=camera.orientation||[0,0,0,1];
      const forward=M.quatRotateVector(orientation,[0,0,-1]),up=M.quatRotateVector(orientation,[0,1,0]),target=M.add3(position,forward);
      gl.viewport(0,0,left,h);gl.scissor(0,0,left,h);gl.clearColor(0.045,0.055,0.065,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);this.renderScene(perspective(camera.fov||50,left/h),lookAt(position,target,up));
      gl.viewport(left,0,right,h);gl.scissor(left,0,right,h);gl.clearColor(0.025,0.03,0.036,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);this.renderScene(perspective(52,right/h),lookAt([7,7.5,8],[0,0.8,0],[0,1,0]),{observer:true});
    }
    destroy(){const gl=this.gl;try{gl.deleteBuffer(this.cubeBuffer);gl.deleteBuffer(this.gridBuffer);gl.deleteBuffer(this.dynamicBuffer);gl.deleteProgram(this.program);}catch{}}
  }

  window.FilmMateBlockoutRenderer=BlockoutRenderer;
})();
