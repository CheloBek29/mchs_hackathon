export const RetroPostShader = {
  uniforms: {
    tDiffuse: { value: null },
    uColorLevels: { value: 28.0 },
    uDitherStrength: { value: 0.62 },
    uTime: { value: 0.0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uColorLevels;
    uniform float uDitherStrength;
    uniform float uTime;

    float bayer8(vec2 p) {
      int x = int(mod(p.x, 8.0));
      int y = int(mod(p.y, 8.0));
      int i = x + y * 8;
      float m[64];
      m[0]=0.0; m[1]=48.0; m[2]=12.0; m[3]=60.0; m[4]=3.0; m[5]=51.0; m[6]=15.0; m[7]=63.0;
      m[8]=32.0; m[9]=16.0; m[10]=44.0; m[11]=28.0; m[12]=35.0; m[13]=19.0; m[14]=47.0; m[15]=31.0;
      m[16]=8.0; m[17]=56.0; m[18]=4.0; m[19]=52.0; m[20]=11.0; m[21]=59.0; m[22]=7.0; m[23]=55.0;
      m[24]=40.0; m[25]=24.0; m[26]=36.0; m[27]=20.0; m[28]=43.0; m[29]=27.0; m[30]=39.0; m[31]=23.0;
      m[32]=2.0; m[33]=50.0; m[34]=14.0; m[35]=62.0; m[36]=1.0; m[37]=49.0; m[38]=13.0; m[39]=61.0;
      m[40]=34.0; m[41]=18.0; m[42]=46.0; m[43]=30.0; m[44]=33.0; m[45]=17.0; m[46]=45.0; m[47]=29.0;
      m[48]=10.0; m[49]=58.0; m[50]=6.0; m[51]=54.0; m[52]=9.0; m[53]=57.0; m[54]=5.0; m[55]=53.0;
      m[56]=42.0; m[57]=26.0; m[58]=38.0; m[59]=22.0; m[60]=41.0; m[61]=25.0; m[62]=37.0; m[63]=21.0;
      return m[i] / 64.0;
    }

    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 color = tex.rgb;

      float n = bayer8(gl_FragCoord.xy + vec2(uTime * 11.0, uTime * 7.0)) - 0.5;
      color += n * (uDitherStrength / max(1.0, uColorLevels));

      color = floor(color * uColorLevels) / uColorLevels;
      color = clamp(color, 0.0, 1.0);

      gl_FragColor = vec4(color, tex.a);
    }
  `,
};

