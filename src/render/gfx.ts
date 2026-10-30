/** graphics profile, set before the world is built: `lite` is the TV box (a Mali-class GPU) */
export const GFX = {
  lite: false,
  /** lite only: hardware MSAA on the canvas */
  aa: true,
  /** lite only: Lambert shading for the still scenery instead of physically based */
  lambert: false,
  /** lite only: the scenery receives the kept shadow map */
  recv: true,
  /** lite only: bodies cast planar (flattened) shadows; otherwise a soft quad along the sun */
  planar: false,
};
