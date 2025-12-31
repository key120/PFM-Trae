import type { HeadingNode } from './docParser'

type StyleConfig = {
  cssClass: string
  fontSize?: string
  fontWeight?: string
  lineHeight?: string
  marginTop?: string
  marginBottom?: string
  textAlign?: string
  marginLeft?: string
}

type StyleMapping = Record<string, StyleConfig>

export const DEFAULT_STYLE_MAPPING: StyleMapping = {
  Heading1: { cssClass: 'doc-heading-1', fontSize: '24px', fontWeight: 'bold', lineHeight: '1.3', marginTop: '24px', marginBottom: '16px', textAlign: 'left' },
  Heading2: { cssClass: 'doc-heading-2', fontSize: '20px', fontWeight: 'bold', lineHeight: '1.4', marginTop: '20px', marginBottom: '14px', textAlign: 'left' },
  Heading3: { cssClass: 'doc-heading-3', fontSize: '18px', fontWeight: 'bold', lineHeight: '1.4', marginTop: '18px', marginBottom: '12px', textAlign: 'left' },
  Heading4: { cssClass: 'doc-heading-4', fontSize: '16px', fontWeight: 'bold', lineHeight: '1.5', marginTop: '16px', marginBottom: '10px' },
  Heading5: { cssClass: 'doc-heading-5', fontSize: '14px', fontWeight: 'bold', lineHeight: '1.5', marginTop: '14px', marginBottom: '8px' },
  Heading6: { cssClass: 'doc-heading-6', fontSize: '12px', fontWeight: 'bold', lineHeight: '1.5', marginTop: '12px', marginBottom: '8px' },
  Normal: { cssClass: 'doc-paragraph', fontSize: '14px', lineHeight: '1.8', marginBottom: '8px' },
  ListParagraph: { cssClass: 'doc-list-item', fontSize: '14px', lineHeight: '1.8', marginLeft: '24px' }
}

export class StyleMapper {
  private mapping: StyleMapping
  private styleElement: HTMLStyleElement | null

  constructor(mapping: StyleMapping = DEFAULT_STYLE_MAPPING) {
    this.mapping = mapping
    this.styleElement = null
    this.injectStyleSheet()
  }

  private injectStyleSheet(): void {
    const style = document.createElement('style')
    let css = ''

    const toCssProp = (p: string) => p.replace(/[A-Z]/g, '-$&').toLowerCase()

    Object.values(this.mapping).forEach(cfg => {
      if (!cfg.cssClass) return
      css += `.${cfg.cssClass} {\n`
      Object.entries(cfg).forEach(([k, v]) => {
        if (k === 'cssClass' || v === undefined) return
        css += `  ${toCssProp(k)}: ${v};\n`
      })
      css += `}\n\n`
    })

    style.textContent = css
    document.head.appendChild(style)
    this.styleElement = style
  }

  applyGeneric(container: HTMLElement): void {
    const blocks = Array.from(container.querySelectorAll('.docx p, .docx div')) as HTMLElement[]
    blocks.forEach(el => {
      const text = (el.textContent || '').trim()
      const isHeadingLike = this.isHeadingLike(el)
      if (!isHeadingLike) {
        if (!el.classList.contains('doc-paragraph')) el.classList.add('doc-paragraph')
        if (this.isListItem(text)) el.classList.add('doc-list-item')
      }
    })
  }

  applyHeadingClasses(mapped: { element: HTMLElement; heading: HeadingNode }[]): void {
    mapped.forEach(({ element, heading }) => {
      const level = Math.max(1, Math.min(6, heading.level))
      element.classList.add(`doc-heading-${level}`)
      element.classList.remove('doc-paragraph')
      element.classList.remove('doc-list-item')
    })
  }

  destroy(): void {
    if (this.styleElement && this.styleElement.parentNode) {
      this.styleElement.parentNode.removeChild(this.styleElement)
      this.styleElement = null
    }
  }

  private isHeadingLike(el: HTMLElement): boolean {
    const tag = el.tagName
    if (/^H[1-6]$/.test(tag)) return true
    const weight = window.getComputedStyle(el).fontWeight
    const size = parseFloat(window.getComputedStyle(el).fontSize || '0')
    return (weight === 'bold' || parseInt(weight, 10) >= 600) && size >= 18
  }

  private isListItem(text: string): boolean {
    return /^[\s]*([•·▪▫\-–—*]|\d+[\.\)])\s+/.test(text)
  }
}

