/**
 * DUMP_RAW=1 환경변수 설정 시 플랫폼 raw API 응답 샘플을
 * docs/api-samples/{platform}/{YYYY-MM-DD}.json 에 자동 저장.
 *
 * 각 POC 는 mapOrder 직전(원본) 또는 fetch 응답 파싱 직후에
 * `dumper.add(rawItem)` 호출 → run 종료 시 `dumper.flush(targetDate)`.
 *
 * 샘플은 플랫폼당 최대 N개 (default 5) 저장. 전체 raw 를 repo 에 커밋하면
 * 용량 크고 민감정보 리스크 있으므로 sampleLimit 로 제한.
 *
 * Usage:
 *   DUMP_RAW=1 npx electron scripts/poc-baemin.js --id=... --pw=...
 */

const fs = require('fs');
const path = require('path');

class RawDumper {
  /**
   * @param {string} platform  'baemin' | 'coupangeats' | 'yogiyo' | 'ddangyoyo'
   * @param {number} sampleLimit  기본 5건
   */
  constructor(platform, sampleLimit = 5) {
    this.enabled = process.env.DUMP_RAW === '1';
    this.platform = platform;
    this.sampleLimit = sampleLimit;
    this.samples = [];
  }

  add(sample) {
    if (!this.enabled) return;
    if (this.samples.length >= this.sampleLimit) return;
    this.samples.push(sample);
  }

  /**
   * @param {string} targetDate  'YYYY-MM-DD' 등 파일명에 쓸 식별자
   * @param {object} [meta]  추가 메타 정보 (shopNumber, shopName 등)
   */
  flush(targetDate, meta = {}) {
    if (!this.enabled) return null;
    if (this.samples.length === 0) {
      console.log(`[DUMP_RAW ${this.platform}] 샘플 없음, skip`);
      return null;
    }
    const dir = path.join(__dirname, '..', '..', 'docs', 'api-samples', this.platform);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${targetDate || 'latest'}.json`);
    const payload = {
      exportedAt: new Date().toISOString(),
      platform: this.platform,
      targetDate,
      sampleCount: this.samples.length,
      meta,
      samples: this.samples,
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`[DUMP_RAW ${this.platform}] ${this.samples.length}건 → ${file}`);
    return file;
  }
}

module.exports = { RawDumper };
