using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;

namespace Jellyfin.Plugin.ArtworkPlus.Helpers;

/// <summary>
/// Games: the games of the Playnite Bridge plugin are VIRTUAL - its MVC filter answers Jellyfin's
/// item endpoints, nothing is in Jellyfin's database, so GetItemById returns
/// null for a game. Playnite Bridge offers the read-only static class
/// Jellyfin.Plugin.PlayniteBridge.ArtworkPlusLink; it is found here by
/// reflection over every AssemblyLoadContext, the File Transformation
/// pattern - no project reference, no DLL dependency. Without Playnite
/// Bridge every call answers false / null / empty, so all callers behave
/// as if no games existed. Only plain types cross the boundary
/// (each plugin has its own load context).
/// </summary>
internal static class PlayniteBridgeLink
{
    private const string TypeName = "Jellyfin.Plugin.PlayniteBridge.ArtworkPlusLink";

    private static readonly object Gate = new();
    private static volatile bool _resolved;
    private static volatile bool _present;
    private static MethodInfo? _isGame;
    private static MethodInfo? _gameFolder;
    private static MethodInfo? _image;
    private static MethodInfo? _backdrops;
    private static MethodInfo? _libraryBackdrops;
    private static MethodInfo? _fileNames;
    private static MethodInfo? _versionImageId;
    private static MethodInfo? _drawsGames;
    private static MethodInfo? _isCollection;
    private static MethodInfo? _collectionMembers;
    private static MethodInfo? _collectionImages;

    /// <summary>True when Playnite Bridge's ArtworkPlusLink class is loaded (the plugin is installed, whether or not it has data yet).</summary>
    public static bool Present
    {
        get
        {
            Resolve();
            return _present;
        }
    }

    // Not used: IsVisibleTo(Guid, Guid). The Detail View endpoints are anonymous like Playnite Bridge's own
    // image endpoint (and like GetItemById for every other item) - there is no user to check there; the
    // Library View list is already filtered by Playnite Bridge for the requesting user.

    /// <summary>True for any version / twin id of a Playnite Bridge game (extras and collections are no games).</summary>
    public static bool IsGame(Guid id) => Call(() => _isGame, id) is true;

    /// <summary>True for a collection of Playnite Bridge's games (a virtual folder, no game).</summary>
    public static bool IsCollection(Guid id) => Call(() => _isCollection, id) is true;

    /// <summary>The games of a collection the user may see (each group's main version): id, release date, sort name; in sort name order.</summary>
    public static IReadOnlyList<(Guid Id, DateTime? Released, string SortName)> CollectionMembers(Guid id, Guid userId)
    {
        if (Call(() => _collectionMembers, id, userId) is not string[][] list) { return Array.Empty<(Guid, DateTime?, string)>(); }
        var result = new List<(Guid, DateTime?, string)>();
        foreach (var e in list)
        {
            if (e is { Length: 3 } && Guid.TryParse(e[0], out var game))
            {
                result.Add((game, DateTime.TryParse(e[1], CultureInfo.InvariantCulture, DateTimeStyles.None, out var released) ? released : null, e[2] ?? string.Empty));
            }
        }

        return result;
    }

    /// <summary>The collection's own backdrops in file order (index = /Items/{id}/Images/Backdrop/{index}).</summary>
    public static IReadOnlyList<(string Path, string Tag)> CollectionBackdrops(Guid id)
        => Call(() => _collectionImages, id, "Backdrop") is string[][] list
            // a malformed entry keeps its place (empty tag = skipped by the caller), so every later index stays right
            ? list.Select(p => p is { Length: 2 } ? (p[0] ?? string.Empty, p[1] ?? string.Empty) : (string.Empty, string.Empty)).ToList()
            : Array.Empty<(string, string)>();

    /// <summary>The game's image folder (full path), null when there is none.</summary>
    public static string? GameFolder(Guid id) => Call(() => _gameFolder, id) as string;

    /// <summary>The image folder of the version whose CharacterArt is shown under the Version Change rule; null = none.</summary>
    public static string? GameFolder(Guid id, Guid? firstId) => VersionImageId(id, firstId, "Characterart") is Guid source ? GameFolder(source) : null;

    /// <summary>
    /// Playnite Bridge's "Settings From": false = Playnite Bridge draws the games' artwork itself, so every
    /// ArtworkPlus feature answers "not applicable" for a game. No such function = true (ArtworkPlus draws the artwork).
    /// </summary>
    public static bool DrawsGames => Call(() => _drawsGames) is not false;

    /// <summary>"Logo" or "Art": (file path, Jellyfin image tag) of an existing file, null otherwise.</summary>
    public static (string Path, string Tag)? Image(Guid id, string type)
        => Call(() => _image, id, type) is string[] { Length: 2 } pair ? (pair[0], pair[1]) : null;

    /// <summary>The game's backdrops in Jellyfin's index order (index = /Items/{id}/Images/Backdrop/{index}).</summary>
    public static IReadOnlyList<(string Path, string Tag)> Backdrops(Guid id)
        => Call(() => _backdrops, id) is string[][] list
            // a malformed entry keeps its place (empty tag = skipped by the caller), so every later index stays right
            ? list.Select(p => p is { Length: 2 } ? (p[0] ?? string.Empty, p[1] ?? string.Empty) : (string.Empty, string.Empty)).ToList()
            : Array.Empty<(string, string)>();

    /// <summary>
    /// Library View: one entry per game of the games library that the user may see and that has a backdrop
    /// (tile order, the tile's main version): its id, backdrop 0 (path, tag) and whether it is a Playnite
    /// favourite (= UserData.IsFavorite of the tile). Empty for any other library. No selection on Playnite
    /// Bridge's side: the caller picks like Jellyfin's autoBackdrops.
    /// </summary>
    public static IReadOnlyList<(Guid Id, string Path, string Tag, bool Favorite)> LibraryBackdrops(Guid libraryId, Guid userId)
    {
        if (Call(() => _libraryBackdrops, libraryId, userId) is not string[][] list) { return Array.Empty<(Guid, string, string, bool)>(); }
        var result = new List<(Guid, string, string, bool)>();
        foreach (var e in list)
        {
            if (e is { Length: 4 } && Guid.TryParse(e[0], out var id))
            {
                result.Add((id, e[1], e[2], string.Equals(e[3], "true", StringComparison.OrdinalIgnoreCase)));
            }
        }

        return result;
    }

    /// <summary>
    /// The base names (no extension, in priority order) Playnite Bridge is configured to use for one image type,
    /// e.g. "CharacterArt" -> ["characterart", "cutout"]; empty = the type is Off. Null when Playnite Bridge does
    /// not offer the function, so the caller keeps its own name.
    /// </summary>
    public static string[]? FileNames(string type) => Call(() => _fileNames, type) as string[];

    /// <summary>
    /// Version Change rule (Playnite Bridge's table "Artwork on Version Change"): the version whose image of
    /// one type ("Backdrop", "Logo", "Clearart", "Characterart") is shown while pickedId is open and firstId was opened
    /// first. Null = no image. No firstId, the same id, or no such function in Playnite Bridge = pickedId.
    /// </summary>
    public static Guid? VersionImageId(Guid pickedId, Guid? firstId, string type)
    {
        if (firstId is null || firstId.Value == pickedId) { return pickedId; }
        Resolve();
        if (_versionImageId is null) { return pickedId; }
        return Call(() => _versionImageId, pickedId, firstId.Value, type) is string id && Guid.TryParse(id, out var source) ? source : null;
    }

    private static object? Call(Func<MethodInfo?> pick, params object[] args)
    {
        Resolve();
        var method = pick();
        if (method is null) { return null; }
        try
        {
            return method.Invoke(null, args);
        }
        catch (Exception)
        {
            // Playnite Bridge failing must never break an ArtworkPlus answer: treat it as "no game".
            return null;
        }
    }

    private static void Resolve()
    {
        if (_resolved) { return; }
        lock (Gate)
        {
            if (_resolved) { return; }
            try
            {
                Type? type = null;
                foreach (var asm in AssemblyLoadContext.All.SelectMany(ctx => ctx.Assemblies))
                {
                    // one unreadable assembly of some other plugin must not stop the search (nor break the caller)
                    try { type = asm.GetType(TypeName, false); } catch (Exception) { continue; }
                    if (type is not null) { break; }
                }

                if (type is not null)
                {
                    _isGame = type.GetMethod("IsGame", new[] { typeof(Guid) });
                    _gameFolder = type.GetMethod("GameFolder", new[] { typeof(Guid) });
                    _image = type.GetMethod("Image", new[] { typeof(Guid), typeof(string) });
                    _backdrops = type.GetMethod("Backdrops", new[] { typeof(Guid) });
                    _libraryBackdrops = type.GetMethod("LibraryBackdrops", new[] { typeof(Guid), typeof(Guid) });
                    _fileNames = type.GetMethod("FileNames", new[] { typeof(string) });
                    _versionImageId = type.GetMethod("VersionImageId", new[] { typeof(Guid), typeof(Guid), typeof(string) });
                    _drawsGames = type.GetMethod("ArtworkPlusDrawsGames", Type.EmptyTypes);
                    _isCollection = type.GetMethod("IsCollection", new[] { typeof(Guid) });
                    _collectionMembers = type.GetMethod("CollectionMembers", new[] { typeof(Guid), typeof(Guid) });
                    _collectionImages = type.GetMethod("CollectionImages", new[] { typeof(Guid), typeof(string) });
                    _present = true;
                }
            }
            catch (Exception)
            {
                // no Playnite Bridge for this run - every call answers false / null / empty
            }
            finally
            {
                _resolved = true;
            }
        }
    }
}
