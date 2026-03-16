const TEMPLATE_SAMPLE_PDFS_KEY = "templateSamplePdfs";

export async function loadTemplates() {
  const data = await chrome.storage.local.get("templates");
  return data.templates || [];
}

export async function saveTemplates(templates) {
  await chrome.storage.local.set({ templates });
}

export async function upsertTemplate(template) {
  const templates = await loadTemplates();
  const idx = templates.findIndex((t) => t.id === template.id);
  if (idx >= 0) {
    templates[idx] = template;
  } else {
    templates.push(template);
  }
  await saveTemplates(templates);
}

export async function deleteTemplateById(templateId) {
  const templates = await loadTemplates();
  await saveTemplates(templates.filter((t) => t.id !== templateId));
  await deleteTemplateSamplePdf(templateId);
}

export async function getSelectedTemplateId() {
  const data = await chrome.storage.local.get("selectedTemplateId");
  return data.selectedTemplateId || null;
}

export async function setSelectedTemplateId(id) {
  await chrome.storage.local.set({ selectedTemplateId: id });
}

async function loadTemplateSamplePdfMap() {
  const data = await chrome.storage.local.get(TEMPLATE_SAMPLE_PDFS_KEY);
  return data[TEMPLATE_SAMPLE_PDFS_KEY] || {};
}

async function saveTemplateSamplePdfMap(map) {
  await chrome.storage.local.set({ [TEMPLATE_SAMPLE_PDFS_KEY]: map });
}

export async function getTemplateSamplePdf(templateId) {
  const map = await loadTemplateSamplePdfMap();
  return map[templateId] || null;
}

export async function saveTemplateSamplePdf(templateId, samplePdf) {
  const map = await loadTemplateSamplePdfMap();
  map[templateId] = samplePdf;
  await saveTemplateSamplePdfMap(map);
}

export async function deleteTemplateSamplePdf(templateId) {
  const map = await loadTemplateSamplePdfMap();
  if (!map[templateId]) {
    return;
  }
  delete map[templateId];
  await saveTemplateSamplePdfMap(map);
}
