// When to reach for the image generator sub-agent — for every agent that can spawn it.
export const IMAGE_GENERATOR_SUBAGENT_NOTE =
  'When a task needs a raster image generated or edited — an illustration, a photo-like picture, a banner, an ' +
  'icon, a variant or a correction of an existing image — spawn the image_generator sub-agent (spawn_agent): a ' +
  "session with OpenAI's built-in image generation, running in a child thread; drive it with send_to_thread. " +
  'Give it the brief: what the image is for, its content and style, the size or aspect ratio, any exact text it ' +
  'must carry, and reference images — as fileIds, or as paths in the workspace file area. It replies with the ' +
  'finished images attached as stored fileIds; what happens to them is yours to decide (send_file to show them, ' +
  'workspace_import_file to keep them in the workspace file area under a fitting name). It never ends on its ' +
  'own: ask for corrections and variants in the same thread, and tell it to finish when the images are done.';
