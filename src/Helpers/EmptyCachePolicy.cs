using System;

namespace Jellyfin.Plugin.ArtworkPlus.Helpers;

/// <summary>
/// When a People Backdrops cache file that holds no images counts
/// as absent. Pure function so it can be tested on its own: an
/// empty file without CheckedAt is always absent, an empty result is trusted
/// for <paramref name="retryDays"/> days, files with images never expire.
/// </summary>
public static class EmptyCachePolicy
{
    public static bool IsExpired(int imageCount, DateTime? checkedAtUtc, DateTime nowUtc, int retryDays)
    {
        if (imageCount > 0) { return false; }
        if (!checkedAtUtc.HasValue) { return true; }
        return (nowUtc - checkedAtUtc.Value).TotalDays >= retryDays;
    }
}
