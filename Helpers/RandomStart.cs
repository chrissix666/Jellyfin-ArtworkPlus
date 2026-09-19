using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.ArtworkPlus.Helpers;

/// <summary>
/// Session 127: "Random start position" - a sorted slideshow begins at a
/// random entry of its list and continues in order from there (wrapping),
/// as if it had been running for a while. Only meaningful for a sorted
/// order that loops; every caller checks its own order/loop conditions and
/// then rotates the finished list by a random offset. The client never
/// knows: it always starts at index 0 of what the server sends.
/// </summary>
public static class RandomStart
{
    /// <summary>A copy of <paramref name="list"/> rotated by a random offset; lists shorter than 2 come back unchanged.</summary>
    public static List<T> Rotate<T>(List<T> list)
    {
        if (list.Count < 2) { return list; }
        var offset = Random.Shared.Next(1, list.Count);
        var rotated = new List<T>(list.Count);
        rotated.AddRange(list.GetRange(offset, list.Count - offset));
        rotated.AddRange(list.GetRange(0, offset));
        return rotated;
    }

    /// <summary>True when a real sort field starts at a random offset: the new checkbox, or a legacy Traversal value saved before Session 127.</summary>
    public static bool ForTraversal(bool randomStartChecked, string? traversalMode) =>
        randomStartChecked || traversalMode == "RandomStartAscending" || traversalMode == "RandomStartDescending";
}
