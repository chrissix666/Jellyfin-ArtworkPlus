// ArtworkPlus - live smoke test of every Backdrops server endpoint.
//
// Run INSIDE a logged-in Jellyfin tab (DevTools console, or Claude's
// javascript_tool): it uses the page's own ApiClient, so the session token
// is handled by Jellyfin's client and never leaves the page. Real IDs are
// looked up through the library (first genre/studio/tag/person that exists).
//
// Catches the class of bug the unit-level suite cannot see: a controller
// that compiles but throws at runtime (Session 116: "no such column:
// IsFavorite" - HTTP 500 on both Favorites pools while every client test
// stayed green because the endpoints were stubbed).
//
// Prints one line per endpoint and ends with SMOKE OK / SMOKE FAILED.
(async function () {
    var api = window.ApiClient;
    var uid = api.getCurrentUserId();
    var out = [];
    var fails = 0;
    function line(ok, name, info) { out.push((ok ? 'ok   ' : 'FAIL ') + name.padEnd(28) + ' ' + info); if (!ok) { fails++; } }

    async function getJson(path, params) {
        var url = api.getUrl(path, params || {});
        try {
            var r = await fetch(url, { headers: { Authorization: api.getAuthorizationHeader ? api.getAuthorizationHeader() : ('MediaBrowser Token="' + api.accessToken() + '"') } });
            var text = await r.text();
            var json = null;
            try { json = JSON.parse(text); } catch (e) { /* not json */ }
            return { status: r.status, json: json, text: text.slice(0, 120) };
        } catch (e) { return { status: 0, json: null, text: String(e) }; }
    }
    async function first(path, params) { var r = await api.getJSON(api.getUrl(path, params)); return (r.Items || [])[0]; }

    // fixtures from the real library
    var movieLib = (await api.getJSON(api.getUrl('Users/' + uid + '/Views'))).Items.find(function (v) { return v.CollectionType === 'movies'; });
    var tvLib = (await api.getJSON(api.getUrl('Users/' + uid + '/Views'))).Items.find(function (v) { return v.CollectionType === 'tvshows'; });
    var genre = await first('Genres', { UserId: uid, ParentId: movieLib && movieLib.Id, Limit: 1 });
    var studio = await first('Studios', { UserId: uid, Limit: 1 });
    var tagged = await first('Users/' + uid + '/Items', { Recursive: true, IncludeItemTypes: 'Movie', Fields: 'Tags', Limit: 50 });
    var tagItems = (await api.getJSON(api.getUrl('Users/' + uid + '/Items', { Recursive: true, IncludeItemTypes: 'Movie', Fields: 'Tags', Limit: 200 }))).Items.filter(function (i) { return i.Tags && i.Tags.length; });
    var tag = tagItems.length ? tagItems[0].Tags[0] : null;
    var movie = await first('Users/' + uid + '/Items', { Recursive: true, IncludeItemTypes: 'Movie', ImageTypes: 'Backdrop', Limit: 1 });
    var person = await first('Persons', { Limit: 1 });

    var checks = [
        ['settings', 'Backdrops/settings', { itemId: movie && movie.Id }, function (j) { return j && typeof j.Enabled === 'boolean'; }],
        ['allowed-indices', 'Backdrops/allowed-indices', { sourceId: movie && movie.Id }, function (j) { return Array.isArray(j); }],
        ['genre-pool (movies)', 'Backdrops/genre-pool', { genreId: genre && genre.Id, parentId: movieLib && movieLib.Id }, function (j) { return j && Array.isArray(j.Images); }],
        ['genre-pool (global)', 'Backdrops/genre-pool', { genreId: genre && genre.Id }, function (j) { return j && Array.isArray(j.Images); }],
        ['studio-settings', 'Backdrops/studio-settings', { studioId: studio && studio.Id }, function (j) { return j && typeof j.HasImage === 'boolean' && typeof j.SourceMode === 'string'; }],
        ['studio-pool', 'Backdrops/studio-pool', { studioId: studio && studio.Id }, function (j) { return j && Array.isArray(j.Images); }],
        ['tag-pool', 'Backdrops/tag-pool', { tag: tag }, function (j) { return j && Array.isArray(j.Images); }],
        ['favorites-pool (Movie)', 'Backdrops/favorites-pool', { type: 'Movie' }, function (j) { return j && Array.isArray(j.Images); }],
        ['favorites-pool (Series)', 'Backdrops/favorites-pool', { type: 'Series' }, function (j) { return j && Array.isArray(j.Images); }],
        ['favorites-pool (Person)', 'Backdrops/favorites-people-pool', {}, function (j) { return j && typeof j.Enabled === 'boolean'; }],
        ['people (info)', 'PeopleBackdrops/' + (person && person.Id), { scope: 'info' }, function (j, raw) { return raw.indexOf('"Type":"Header"') !== -1; }]
    ];
    // user-data sorts must not crash a pool: temporarily impossible to switch config here, so at least hit
    // the pools with the request user attached (getJSON) - the anonymous fallback is covered server-side.
    for (var i = 0; i < checks.length; i++) {
        var c = checks[i];
        if (Object.values(c[2]).some(function (v) { return v === undefined || v === null; })) { line(true, c[0], 'skipped - no fixture in this library'); continue; }
        var r = await getJson(c[1], c[2]);
        var ok = r.status === 200 && c[3](r.json, r.text);
        var info = 'HTTP ' + r.status + (r.json ? (' Enabled=' + r.json.Enabled + (r.json.Images ? ' images=' + r.json.Images.length : '')) : ' ' + r.text);
        line(ok, c[0], info);
    }
    var verdict = fails ? 'SMOKE FAILED (' + fails + ')' : 'SMOKE OK';
    console.log(out.join('\n') + '\n' + verdict);
    return out.concat([verdict]);
})();
