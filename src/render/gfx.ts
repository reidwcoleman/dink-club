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
  /** lite only: share of the body's triangles kept at load (0 = keep all), and whether seams may move */
  slim: 0,
  seams: true,
  /** the canvas: opaque (the compositor needn't blend it with the page) and, optionally, desynchronized (low latency) */
  alpha: false,
  desync: false,
};
