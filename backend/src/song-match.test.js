// Normalization used for "probable duplicate" detection (songMatch.js).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const m = require('./songMatch');

describe('songMatch.fold', () => {
  it('folds accents and Turkish letters (both cases, dotted/dotless i)', () => {
    assert.equal(m.fold('ŞşĞğÇçÖöÜüİıI'), 'ssggccoouuiii');
    assert.equal(m.fold('Ünlü Çağrı İstanbul'), 'unlu cagri istanbul');
    assert.equal(m.fold('Beyoncé Mötley Crüe Straße Øresund'), 'beyonce motley crue strasse oresund');
  });
});

describe('songMatch.metaKey', () => {
  const same = (a, b) => assert.equal(m.metaKey(...a), m.metaKey(...b), `${a} vs ${b}`);
  const differ = (a, b) => assert.notEqual(m.metaKey(...a), m.metaKey(...b), `${a} vs ${b}`);

  it('ignores case, accents and Turkish characters', () => {
    same(['Gülpembe', 'Barış Manço'], ['GULPEMBE', 'BARIS MANCO']);
    same(['Şımarık', 'Tarkan'], ['simarik', 'TARKAN']);
    same(['Sevda Çiçeği', 'Müslüm Gürses'], ['Sevda Cicegi (Sözleri)', 'Muslum Gurses']);
    same(['Gülpembe', 'Barış Manço'], ['Barış Manço - Gülpembe', 'barismanco']);
  });

  it('strips upload noise: official video/audio, lyrics, HD, remaster tags', () => {
    const base = ['Bohemian Rhapsody', 'Queen'];
    for (const t of ['Bohemian Rhapsody (Official Video)', 'Bohemian Rhapsody [Official Audio]',
      'Bohemian Rhapsody - Remastered 2011', 'Bohemian Rhapsody (Remastered 2011)', 'Bohemian Rhapsody - 2011 Remaster',
      'Bohemian Rhapsody (HD)', 'Bohemian Rhapsody | Lyrics', 'Bohemian Rhapsody (Official Music Video) [HD]']) {
      same(base, [t, 'Queen']);
    }
  });

  it('drops featured artists and YouTube channel suffixes, keeps the primary artist', () => {
    same(['Firework', 'Katy Perry'], ['Firework (feat. Someone)', 'Katy Perry ft. Someone']);
    same(['Firework', 'Katy Perry'], ['Firework ft. Someone', 'Katy Perry, Someone']);
    same(['Bohemian Rhapsody', 'Queen'], ['Queen - Bohemian Rhapsody (Official Video)', 'QueenVEVO']);
    same(['Bohemian Rhapsody', 'Queen'], ['Bohemian Rhapsody', 'Queen - Topic']);
    same(['Hey Jude', 'The Beatles'], ['Hey Jude (Remastered 2015)', 'Beatles']);
  });

  it('keeps meaningful versions apart (live, remix, acoustic) and different songs', () => {
    differ(['Song', 'A'], ['Song (Live)', 'A']);
    differ(['Song', 'A'], ['Song (Remix)', 'A']);
    differ(['Song', 'A'], ['Song - Acoustic', 'A']);
    differ(['Song', 'A'], ['Song', 'B']);
    differ(['Song', 'A'], ['Other Song', 'A']);
  });

  it('is null without a usable title or artist', () => {
    assert.equal(m.metaKey('', 'A'), null);
    assert.equal(m.metaKey('Song', '  '), null);
    assert.equal(m.metaKey('(Official Video)', 'A'), null);
  });
});

describe('songMatch helpers', () => {
  it('durationsClose: within ±3s, never for unknown durations', () => {
    assert.equal(m.durationsClose(200, 203), true);
    assert.equal(m.durationsClose(200, 203.5), false);
    assert.equal(m.durationsClose(200, null), false);
    assert.equal(m.durationsClose(0, 0), false);
  });

  it('splitArtistTitle: "Artist - Title" video titles, else the channel', () => {
    assert.deepEqual(m.splitArtistTitle('Tarkan - Şımarık (Official Video)', 'TarkanVEVO'), { artist: 'Tarkan', title: 'Şımarık (Official Video)' });
    assert.deepEqual(m.splitArtistTitle('Şımarık', 'Tarkan - Topic'), { artist: 'Tarkan', title: 'Şımarık' });
  });
});
