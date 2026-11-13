const $ = (selector) => document.querySelector(selector);
const welcome = $('#welcome');
const messages = $('#messages');
const input = $('#messageInput');
const fileInput = $('#fileInput');
const toast = $('#toast');
let history = [];
let toastTimer;

function notify(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2800);
}
function escapeHTML(value) {
  return value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function formatText(text) {
  return text.split(/\n\s*\n/).map(p => `<p>${escapeHTML(p).replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\n/g,'<br>')}</p>`).join('');
}
function addMessage(role, text, citations=[]) {
  welcome.hidden = true;
  const row = document.createElement('div');
  row.className = `message ${role}`;
  if (role === 'assistant') {
    row.innerHTML = `<div class="message-avatar">m</div><div class="message-content">${formatText(text)}${citations.length ? `<div class="citations">${citations.map(c => `<span class="citation">↗ ${escapeHTML(c.name)}</span>`).join('')}</div>` : ''}</div>`;
  } else row.innerHTML = `<div class="message-content">${formatText(text)}</div>`;
  messages.appendChild(row);
  $('#conversation').scrollTop = $('#conversation').scrollHeight;
  return row;
}
async function send(text) {
  const clean = text.trim();
  if (!clean) return;
  input.value = '';
  input.style.height = 'auto';
  addMessage('user', clean);
  const loading = document.createElement('div');
  loading.className = 'message assistant';
  loading.innerHTML = '<div class="message-avatar">m</div><div class="message-content typing">Looking through your library…</div>';
  messages.appendChild(loading);
  $('#conversation').scrollTop = $('#conversation').scrollHeight;
  $('#sendButton').disabled = true;
  try {
    const response = await fetch('/api/chat', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:clean,history})});
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Could not send that message.');
    loading.remove();
    addMessage('assistant', data.answer, data.sources || []);
    history.push({role:'user',content:clean},{role:'assistant',content:data.answer});
    history = history.slice(-12);
  } catch (error) {
    loading.remove();
    addMessage('assistant', error.message || 'Something went wrong. Please try again.');
  } finally { $('#sendButton').disabled = false; input.focus(); }
}
async function refreshSources() {
  try {
    const response = await fetch('/api/sources');
    const {sources} = await response.json();
    const list = $('#sourceList');
    if (!sources.length) { list.innerHTML = '<div class="empty-library">Your sources will appear here.</div>'; return; }
    list.innerHTML = sources.map(s => `<div class="source-item"><span class="source-icon">▤</span><span class="source-name" title="${escapeHTML(s.name)}">${escapeHTML(s.name)}</span><button class="delete-source" data-id="${escapeHTML(s.id)}" aria-label="Remove ${escapeHTML(s.name)}">×</button></div>`).join('');
    list.querySelectorAll('.delete-source').forEach(button => button.addEventListener('click', async () => {
      if (!confirm('Remove this source from your library?')) return;
      const response = await fetch(`/api/sources/${encodeURIComponent(button.dataset.id)}`, {method:'DELETE'});
      if (response.ok) { notify('Source removed'); refreshSources(); }
    }));
  } catch { /* API not ready yet */ }
}
async function uploadFiles(files) {
  for (const file of files) {
    const form = new FormData();
    form.append('file', file);
    const status = $('#uploadStatus');
    status.hidden = false;
    status.classList.remove('processing');
    $('#uploadName').textContent = file.name;
    $('#uploadPercent').textContent = '0%';
    $('#uploadProgress').style.width = '0%';
    $('#uploadPhase').textContent = 'Uploading file';

    try {
      const data = await new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('POST', '/api/upload');
        request.upload.addEventListener('progress', event => {
          if (!event.lengthComputable) return;
          const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
          $('#uploadPercent').textContent = `${percent}%`;
          $('#uploadProgress').style.width = `${percent}%`;
          if (percent >= 100) {
            status.classList.add('processing');
            $('#uploadPhase').textContent = 'Reading and indexing document…';
            $('#uploadPercent').textContent = 'Indexing';
          }
        });
        request.addEventListener('load', () => {
          let result;
          try { result = JSON.parse(request.responseText); }
          catch { reject(new Error('The server returned an unreadable response.')); return; }
          if (request.status < 200 || request.status >= 300) {
            reject(new Error(result.detail || 'Upload failed.'));
            return;
          }
          resolve(result);
        });
        request.addEventListener('error', () => reject(new Error('Upload failed. Check that the app is still running.')));
        request.addEventListener('abort', () => reject(new Error('Upload cancelled.')));
        request.send(form);
      });
      status.classList.remove('processing');
      $('#uploadProgress').style.width = '100%';
      $('#uploadPercent').textContent = '100%';
      $('#uploadPhase').textContent = 'Added to your library';
      refreshSources();
      await new Promise(resolve => setTimeout(resolve, 900));
    } catch (error) {
      status.classList.remove('processing');
      $('#uploadPercent').textContent = 'Error';
      $('#uploadPhase').textContent = error.message;
      $('#uploadPhase').title = error.message;
      await new Promise(resolve => setTimeout(resolve, 2400));
    }
  }
  $('#uploadStatus').hidden = true;
}
$('#chatForm').addEventListener('submit', event => { event.preventDefault(); send(input.value); });
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight,130)}px`; });
input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(input.value); } });
document.querySelectorAll('.suggestion').forEach(button => button.addEventListener('click', () => send(button.dataset.prompt)));
$('#newChat').addEventListener('click', () => { history=[];messages.innerHTML='';welcome.hidden=false;input.focus(); });
$('#addSource').addEventListener('click', () => fileInput.click());
$('#addFirst').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files.length) uploadFiles(fileInput.files); fileInput.value=''; });
$('#helpButton').addEventListener('click', () => $('#helpDialog').showModal());
$('#closeDialog').addEventListener('click', () => $('#helpDialog').close());
$('#helpDialog').addEventListener('click', event => { if (event.target === $('#helpDialog')) $('#helpDialog').close(); });
window.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase()==='k') { event.preventDefault();$('#newChat').click(); } });
const overlay = $('#dropOverlay');
window.addEventListener('dragover', event => { event.preventDefault();overlay.classList.add('visible'); });
window.addEventListener('dragleave', event => { if (!event.relatedTarget) overlay.classList.remove('visible'); });
window.addEventListener('drop', event => { event.preventDefault();overlay.classList.remove('visible');if(event.dataTransfer.files.length)uploadFiles(event.dataTransfer.files); });
refreshSources();
