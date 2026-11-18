/**
 * Client half: a full image-studio panel plus its sidebar icon.
 *
 * Talks to the Host half through `/studio/api/*` routes, so it needs no
 * @deepseek-ai runtime imports.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-studio',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const HISTORY_KEY = 'sd-studio-history'
    const SIZES = ['512x512', '512x768', '768x512', '768x768', '1024x1024']
    const PROMPTS_KEY = 'sd-studio-prompts'
    const TAG_GROUPS = [
      {
        name: '人物',
        tags: [
          { t: '1girl', zh: '一个女孩' }, { t: 'solo', zh: '单人' }, { t: 'long hair', zh: '长发' },
          { t: 'black hair', zh: '黑发' }, { t: 'blue eyes', zh: '蓝眼' }, { t: 'school uniform', zh: '校服' },
          { t: 'white dress', zh: '白裙' }, { t: 'smile', zh: '微笑' }, { t: 'looking at viewer', zh: '看向镜头' },
        ],
      },
      {
        name: '场景',
        tags: [
          { t: 'seaside', zh: '海边' }, { t: 'city street', zh: '城市街道' }, { t: 'forest', zh: '森林' },
          { t: 'bedroom', zh: '卧室' }, { t: 'cafe', zh: '咖啡馆' }, { t: 'night', zh: '夜晚' },
          { t: 'rain', zh: '下雨' }, { t: 'cherry blossoms', zh: '樱花' }, { t: 'rooftop', zh: '天台' },
        ],
      },
      {
        name: '风格',
        tags: [
          { t: 'anime', zh: '动漫' }, { t: 'illustration', zh: '插画' }, { t: 'photorealistic', zh: '写实照片' },
          { t: 'watercolor', zh: '水彩' }, { t: 'oil painting', zh: '油画' }, { t: 'cyberpunk', zh: '赛博朋克' },
          { t: 'pixel art', zh: '像素风' },
        ],
      },
      {
        name: '光影',
        tags: [
          { t: 'soft light', zh: '柔光' }, { t: 'golden hour', zh: '黄金时刻' }, { t: 'cinematic lighting', zh: '电影光' },
          { t: 'backlight', zh: '逆光' }, { t: 'rim light', zh: '轮廓光' }, { t: 'volumetric lighting', zh: '体积光' },
        ],
      },
      {
        name: '构图',
        tags: [
          { t: 'close-up', zh: '特写' }, { t: 'full body', zh: '全身' }, { t: 'from above', zh: '俯视' },
          { t: 'depth of field', zh: '景深' }, { t: 'wide shot', zh: '广角' },
        ],
      },
      {
        name: '画质',
        tags: [
          { t: 'masterpiece', zh: '杰作' }, { t: 'best quality', zh: '最佳质量' }, { t: 'highly detailed', zh: '高细节' },
          { t: '8k', zh: '8K' }, { t: 'sharp focus', zh: '清晰对焦' },
        ],
      },
    ]

    function loadSavedPrompts() {
      try {
        const raw = window.localStorage.getItem(PROMPTS_KEY)
        const parsed = raw === null ? [] : JSON.parse(raw)
        return Array.isArray(parsed) ? parsed.slice(0, 20) : []
      } catch {
        return []
      }
    }

    function saveSavedPrompts(items) {
      try {
        window.localStorage.setItem(PROMPTS_KEY, JSON.stringify(items.slice(0, 20)))
      } catch {
        // Ignore storage failures.
      }
    }

    function loadHistory() {
      try {
        const raw = window.localStorage.getItem(HISTORY_KEY)
        const parsed = raw === null ? [] : JSON.parse(raw)
        return Array.isArray(parsed) ? parsed.slice(0, 24) : []
      } catch {
        return []
      }
    }

    function saveHistory(items) {
      try {
        window.localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 24)))
      } catch {
        // Ignore storage failures.
      }
    }

    const labelStyle = {
      fontSize: 12,
      color: 'var(--dsw-alias-label-secondary)',
      marginBottom: 4,
      display: 'block',
    }

    const fieldStyle = {
      width: '100%',
      boxSizing: 'border-box',
      font: 'inherit',
      fontSize: 13,
      padding: '8px 10px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
      outline: 'none',
    }

    function PanelIcon({ size = 20, active = false }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block', opacity: active ? 1 : 0.85 },
      },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('circle', { cx: 8.5, cy: 9.5, r: 1.6, fill: 'currentColor' }),
        h('path', {
          d: 'M4.5 18l5.2-5.2 3.6 3.6 2.6-2.6 4.1 4.1',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function Studio() {
      const [status, setStatus] = React.useState({ running: false, starting: false, model: '' })
      const [prompt, setPrompt] = React.useState('')
      const [negative, setNegative] = React.useState('')
      const [size, setSize] = React.useState('512x512')
      const [steps, setSteps] = React.useState(20)
      const [seed, setSeed] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [result, setResult] = React.useState(null)
      const [history, setHistory] = React.useState(loadHistory)
      const [savedPrompts, setSavedPrompts] = React.useState(loadSavedPrompts)
      const [activeGroup, setActiveGroup] = React.useState(0)
      const [mode, setMode] = React.useState('txt2img')
      const [refImage, setRefImage] = React.useState(null)
      const [refName, setRefName] = React.useState(null)
      const [denoise, setDenoise] = React.useState(0.6)
      const [dragOver, setDragOver] = React.useState(false)

      const applyReferenceFile = (file) => {
        if (!file || typeof file.type !== 'string' || !file.type.startsWith('image/')) return
        const reader = new FileReader()
        reader.onload = () => {
          setRefImage(String(reader.result))
          setRefName(null)
          setMode('img2img')
        }
        reader.readAsDataURL(file)
      }

      const handleDrop = (event) => {
        event.preventDefault()
        setDragOver(false)
        const files = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files : null
        if (!files || files.length === 0) return
        applyReferenceFile(files[0])
      }

      const pickReference = () => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'image/*'
        input.onchange = () => {
          const file = input.files && input.files[0]
          if (!file) return
          applyReferenceFile(file)
        }
        input.click()
      }

      const useResultAsReference = () => {
        if (result === null) return
        setRefName(result.url.split('/').pop())
        setRefImage(null)
        setMode('img2img')
      }

      const appendTag = (tag) => {
        setPrompt((current) => {
          const text = current.trim()
          if (text === '') return tag
          const existing = text.split(',').map((part) => part.trim().toLowerCase())
          if (existing.includes(tag.toLowerCase())) return current
          return text.replace(/[,\s]+$/, '') + ', ' + tag
        })
      }

      const rememberPrompt = () => {
        const text = prompt.trim()
        if (text === '') return
        setSavedPrompts((current) => {
          if (current.some((item) => item.text === text)) return current
          const next = [{ name: text.length > 24 ? `${text.slice(0, 24)}…` : text, text }, ...current].slice(0, 20)
          saveSavedPrompts(next)
          return next
        })
      }

      const forgetPrompt = (text) => {
        setSavedPrompts((current) => {
          const next = current.filter((item) => item.text !== text)
          saveSavedPrompts(next)
          return next
        })
      }

      React.useEffect(() => {
        let alive = true
        const poll = async () => {
          try {
            const response = await fetch('/studio/api/status', { headers: { accept: 'application/json' } })
            const data = await response.json()
            if (alive) setStatus({ running: data.running === true, starting: data.starting === true, model: data.model ?? '' })
          } catch {
            if (alive) setStatus({ running: false, starting: false, model: '' })
          }
        }
        poll()
        const timer = setInterval(poll, 4000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      const generate = async () => {
        if (busy) return
        const text = prompt.trim()
        if (text === '') {
          setError('先写提示词')
          return
        }
        setBusy(true)
        setError('')
        const [width, height] = size.split('x').map((value) => Number(value))
        if (mode === 'img2img' && refImage === null && refName === null) {
          setBusy(false)
          setError('图生图需要先选一张参考图')
          return
        }
        try {
          let finalPrompt = text
          if (/[\u3400-\u9fff]/.test(text)) {
            const translated = await fetch('/studio/api/translate', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text }),
            }).then((response) => response.json())
            if (translated.ok !== true) throw new Error(translated.error ?? '中文翻译失败')
            finalPrompt = translated.tags
            setPrompt(finalPrompt)
          }
          const target = mode === 'img2img' ? '/studio/api/img2img' : '/studio/api/generate'
          const response = await fetch(target, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              prompt: finalPrompt,
              negative_prompt: negative,
              width,
              height,
              steps: Number(steps) || 20,
              ...(mode === 'img2img'
                ? {
                    denoise: Number(denoise),
                    ...(refImage !== null ? { image: refImage } : { imageName: refName }),
                  }
                : {}),
              ...(seed.trim() === '' ? {} : { seed: Number(seed) }),
            }),
          })
          const data = await response.json()
          if (data.ok !== true) throw new Error(data.error ?? '生成失败')
          const item = { url: data.url, prompt: finalPrompt, seed: data.seed }
          setResult(data)
          setHistory((current) => {
            const next = [item, ...current].slice(0, 24)
            saveHistory(next)
            return next
          })
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      const clearHistory = async () => {
        if (!window.confirm('删除所有生成记录和图片文件？此操作不可恢复。')) return
        try {
          const response = await fetch('/studio/api/clear', { method: 'POST' })
          const data = await response.json()
          if (data.ok !== true) throw new Error(data.error ?? '删除失败')
          setHistory([])
          saveHistory([])
          setResult(null)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }

      const reveal = async () => {
        if (result === null) return
        try {
          const response = await fetch('/studio/api/reveal', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: result.url }),
          })
          const data = await response.json()
          if (data.ok !== true) setError(data.error ?? '打开文件夹失败')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }

      const serviceAction = async (action) => {
        try {
          await fetch(`/studio/api/${action}`, { method: 'POST' })
          if (action === 'start') setStatus((current) => ({ ...current, starting: true }))
          else setStatus({ running: false, starting: false, model: '' })
        } catch {
          // The poll reports the real state.
        }
      }

      const dotColor = busy || status.starting
        ? 'var(--dsw-alias-state-warn-primary)'
        : status.running
          ? 'var(--dsw-alias-state-success-primary)'
          : 'var(--dsw-alias-state-idle-primary)'
      const statusText = busy
        ? '生成中…'
        : status.starting
          ? '正在启动生图服务…'
          : status.running
            ? `就绪${status.model ? ` · ${status.model}` : ''}`
            : '生图服务未启动（首次生成会自动启动，约 30 秒）'

      return h('div', {
        style: {
          height: '100%',
          boxSizing: 'border-box',
          overflow: 'auto',
          padding: '20px 24px 28px',
          display: 'flex',
          gap: 24,
          alignItems: 'flex-start',
        },
      },
        h('div', {
          style: {
            flex: '0 0 340px',
            width: 340,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', minHeight: 26 } },
            h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: dotColor, flex: '0 0 auto' } }),
            h('span', { style: { flex: 1, minWidth: 0 } }, statusText),
            h('button', {
              type: 'button',
              onClick: () => serviceAction('start'),
              disabled: status.running || status.starting,
              title: '启动生图服务（低显存）',
              style: {
                height: 24,
                padding: '0 10px',
                borderRadius: 6,
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                font: 'inherit',
                fontSize: 12,
                cursor: status.running || status.starting ? 'default' : 'pointer',
                opacity: status.running || status.starting ? 0.45 : 1,
              },
            }, '加载'),
            h('button', {
              type: 'button',
              onClick: () => serviceAction('stop'),
              disabled: !status.running,
              title: '停止生图服务，释放显存',
              style: {
                height: 24,
                padding: '0 10px',
                borderRadius: 6,
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                font: 'inherit',
                fontSize: 12,
                cursor: status.running ? 'pointer' : 'default',
                opacity: status.running ? 1 : 0.45,
              },
            }, '卸载'),
          ),
          h('div', { style: { display: 'flex', gap: 6 } },
            [['txt2img', '文生图'], ['img2img', '图生图']].map(([value, text]) => h('button', {
              key: value,
              type: 'button',
              onClick: () => setMode(value),
              style: {
                flex: 1,
                height: 30,
                borderRadius: 8,
                border: '1px solid ' + (mode === value ? '#2563eb' : 'var(--dsw-alias-border-l1)'),
                background: mode === value ? 'rgba(37,99,235,0.14)' : 'transparent',
                color: mode === value ? '#6ea8ff' : 'var(--dsw-alias-label-secondary)',
                font: 'inherit',
                fontSize: 13,
                cursor: 'pointer',
              },
            }, text)),
          ),
          mode !== 'img2img' ? null : h('div', {
            style: {
              border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: 10,
              padding: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              background: 'var(--dsw-alias-bg-layer-1)',
            },
          },
            h('div', { style: { display: 'flex', gap: 10, alignItems: 'center' } },
              h('div', {
                onClick: pickReference,
                onDragOver: (event) => {
                  event.preventDefault()
                  setDragOver(true)
                },
                onDragLeave: () => setDragOver(false),
                onDrop: handleDrop,
                title: '点击选择，或把图片拖到这里',
                style: {
                  width: 64,
                  height: 64,
                  borderRadius: 8,
                  border: dragOver ? '1px solid #2563eb' : '1px dashed var(--dsw-alias-border-l1)',
                  background: dragOver ? 'rgba(37,99,235,0.12)' : 'transparent',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                  cursor: 'pointer',
                  flex: '0 0 auto',
                },
              },
                refImage !== null
                  ? h('img', { src: refImage, alt: '参考图', style: { width: '100%', height: '100%', objectFit: 'cover' } })
                  : refName !== null
                    ? h('img', { src: `/studio/img/${refName}`, alt: '参考图', style: { width: '100%', height: '100%', objectFit: 'cover' } })
                    : h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)', textAlign: 'center', lineHeight: 1.3 } }, '拖入/点击'),
              ),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, flex: 1 } },
                h('button', {
                  type: 'button',
                  onClick: pickReference,
                  style: {
                    height: 26,
                    borderRadius: 6,
                    border: '1px solid var(--dsw-alias-border-l1)',
                    background: 'transparent',
                    color: 'var(--dsw-alias-label-secondary)',
                    font: 'inherit',
                    fontSize: 12,
                    cursor: 'pointer',
                  },
                }, '上传参考图'),
                h('button', {
                  type: 'button',
                  onClick: useResultAsReference,
                  disabled: result === null,
                  style: {
                    height: 26,
                    borderRadius: 6,
                    border: '1px solid var(--dsw-alias-border-l1)',
                    background: 'transparent',
                    color: 'var(--dsw-alias-label-secondary)',
                    font: 'inherit',
                    fontSize: 12,
                    cursor: result === null ? 'default' : 'pointer',
                    opacity: result === null ? 0.45 : 1,
                  },
                }, '用当前结果'),
              ),
            ),
            h('div', null,
              h('label', { style: { ...labelStyle, marginBottom: 2 } }, `重绘幅度 ${Number(denoise).toFixed(2)}`),
              h('input', {
                type: 'range',
                min: 0.2,
                max: 0.9,
                step: 0.05,
                value: denoise,
                onChange: (event) => setDenoise(Number(event.target.value)),
                style: { width: '100%' },
              }),
            ),
          ),
          h('div', null,
            h('label', { style: labelStyle }, '提示词（英文标签效果最好）'),
            h('textarea', {
              value: prompt,
              onChange: (event) => setPrompt(event.target.value),
              rows: 5,
              placeholder: '1girl, sitting by the sea, sunset, cinematic light, masterpiece',
              style: { ...fieldStyle, resize: 'vertical', lineHeight: 1.5 },
            }),
          ),
          h('div', {
            style: {
              border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: 10,
              padding: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              background: 'var(--dsw-alias-bg-layer-1)',
            },
          },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
              h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '提示词库'),
              h('button', {
                type: 'button',
                onClick: rememberPrompt,
                style: {
                  border: '1px solid var(--dsw-alias-border-l1)',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-secondary)',
                  font: 'inherit',
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 6,
                  cursor: 'pointer',
                },
              }, '保存当前'),
            ),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
              TAG_GROUPS.map((group, index) => h('button', {
                key: group.name,
                type: 'button',
                onClick: () => setActiveGroup(index),
                style: {
                  border: '1px solid ' + (index === activeGroup ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'),
                  color: index === activeGroup ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
                  background: 'transparent',
                  font: 'inherit',
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 6,
                  cursor: 'pointer',
                },
              }, group.name)),
            ),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 96, overflowY: 'auto' } },
              TAG_GROUPS[activeGroup].tags.map((tag) => h('button', {
                key: tag.t,
                type: 'button',
                onClick: () => appendTag(tag.t),
                title: `${tag.t} · ${tag.zh}`,
                style: {
                  border: '1px solid var(--dsw-alias-border-l1)',
                  background: 'var(--dsw-alias-bg-layer-2)',
                  color: 'var(--dsw-alias-label-secondary)',
                  font: 'inherit',
                  padding: '3px 9px',
                  borderRadius: 999,
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  lineHeight: 1.25,
                },
              },
                h('span', { style: { fontSize: 11 } }, tag.t),
                h('span', { style: { fontSize: 10, opacity: 0.6 } }, tag.zh),
              )),
            ),
            savedPrompts.length === 0 ? null : h('div', {
              style: {
                borderTop: '1px solid var(--dsw-alias-border-l1)',
                paddingTop: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              },
            },
              savedPrompts.map((item) => h('div', { key: item.text, style: { display: 'flex', alignItems: 'center', gap: 6 } },
                h('button', {
                  type: 'button',
                  onClick: () => setPrompt(item.text),
                  title: item.text,
                  style: {
                    flex: 1,
                    minWidth: 0,
                    textAlign: 'left',
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--dsw-alias-label-secondary)',
                    font: 'inherit',
                    fontSize: 12,
                    cursor: 'pointer',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    padding: 0,
                  },
                }, item.name),
                h('button', {
                  type: 'button',
                  onClick: () => forgetPrompt(item.text),
                  title: '删除',
                  style: {
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--dsw-alias-label-secondary)',
                    font: 'inherit',
                    fontSize: 12,
                    cursor: 'pointer',
                    padding: 0,
                  },
                }, '×'),
              )),
            ),
          ),
          h('div', null,
            h('label', { style: labelStyle }, '负面提示词'),
            h('textarea', {
              value: negative,
              onChange: (event) => setNegative(event.target.value),
              rows: 2,
              placeholder: 'lowres, bad anatomy, worst quality',
              style: { ...fieldStyle, resize: 'vertical', lineHeight: 1.5 },
            }),
          ),
          h('div', { style: { display: 'flex', gap: 10 } },
            h('div', { style: { flex: 1 } },
              h('label', { style: labelStyle }, '尺寸'),
              h('select', {
                value: size,
                onChange: (event) => setSize(event.target.value),
                style: fieldStyle,
              }, SIZES.map((option) => h('option', { key: option, value: option }, option))),
            ),
            h('div', { style: { flex: 1 } },
              h('label', { style: labelStyle }, '步数'),
              h('input', {
                type: 'number',
                min: 4,
                max: 50,
                value: steps,
                onChange: (event) => setSteps(event.target.value),
                style: fieldStyle,
              }),
            ),
          ),
          h('div', null,
            h('label', { style: labelStyle }, '种子（留空随机）'),
            h('input', {
              value: seed,
              onChange: (event) => setSeed(event.target.value),
              placeholder: '随机',
              style: fieldStyle,
            }),
          ),
          h('button', {
            type: 'button',
            onClick: generate,
            disabled: busy,
            style: {
              marginTop: 4,
              height: 38,
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.18)',
              font: 'inherit',
              fontSize: 14,
              fontWeight: 600,
              color: '#ffffff',
              background: '#2563eb',
              cursor: busy ? 'default' : 'pointer',
              opacity: busy ? 0.7 : 1,
              letterSpacing: '0.02em',
            },
          }, busy ? '生成中…' : '生成'),
          error === '' ? null : h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, lineHeight: 1.5 } }, error),
        ),
        h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 } },
          h('div', {
            onDragOver: (event) => {
              event.preventDefault()
              setDragOver(true)
            },
            onDragLeave: () => setDragOver(false),
            onDrop: handleDrop,
            style: {
              borderRadius: 14,
              border: dragOver ? '1px solid #2563eb' : '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-1)',
              minHeight: 360,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
            },
          },
            result === null
              ? h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13 } }, '生成的图片会显示在这里')
              : h('img', {
                src: result.url,
                alt: '生成结果',
                style: { maxWidth: '100%', maxHeight: '62vh', display: 'block' },
              }),
          ),
          result === null ? null : h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
            h('button', {
              type: 'button',
              onClick: reveal,
              title: '在资源管理器中定位这张图',
              style: {
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                font: 'inherit',
                fontSize: 12,
                padding: '5px 12px',
                borderRadius: 8,
                cursor: 'pointer',
              },
            }, '打开文件夹'),
          ),
          history.length === 0 ? null : h('div', null,
            h('div', {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 8,
              },
            },
              h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '历史'),
              h('button', {
                type: 'button',
                onClick: clearHistory,
                title: '删除所有历史缩略图和图片文件',
                style: {
                  border: '1px solid var(--dsw-alias-border-l1)',
                  background: 'transparent',
                  color: 'var(--dsw-alias-state-error-primary)',
                  font: 'inherit',
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 6,
                  cursor: 'pointer',
                },
              }, '删除历史'),
            ),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
              history.map((item, index) => h('img', {
                key: `${item.url}-${index}`,
                src: item.url,
                alt: item.prompt ?? '',
                title: item.prompt ?? '',
                onClick: () => setResult({ url: item.url, seed: item.seed }),
                style: {
                  width: 96,
                  height: 96,
                  objectFit: 'cover',
                  borderRadius: 8,
                  border: '1px solid var(--dsw-alias-border-l1)',
                  cursor: 'pointer',
                },
              })),
            ),
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'image-studio',
          order: 20,
          label: '生图',
        }, PanelIcon))
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'image-studio' }, Studio))
      },
    }
  },
})
