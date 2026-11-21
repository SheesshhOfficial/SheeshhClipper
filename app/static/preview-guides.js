'use strict';

// A general framing aid, not a platform-specific overlay. Preview only.
function guideBounds(width, height) {
  const vertical = height > width;
  const left = Math.round(width * .08);
  const top = Math.round(height * (vertical ? .09 : .08));
  const right = Math.round(width * (vertical ? .17 : .08));
  const bottom = Math.round(height * (vertical ? .19 : .08));
  return [left, top, width - left - right, height - top - bottom];
}

function drawPreviewGuides(context, width, height) {
  const box = guideBounds(width, height);
  context.save();
  context.setLineDash([7, 5]);
  context.lineWidth = 4;
  context.strokeStyle = '#13111a';
  context.strokeRect(...box);
  context.lineWidth = 1.5;
  context.strokeStyle = '#f7e8ff';
  context.strokeRect(...box);
  context.restore();
}
