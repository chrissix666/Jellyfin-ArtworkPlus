namespace Jellyfin.Plugin.ArtworkPlus.Helpers;

/// <summary>
/// The admin page saves an emptied "Display duration" as 0 and `min="0"`
/// accepts 0; the client slideshows of Characterart, LogoArt and the
/// Extraposter detail page would then switch images on every timer tick.
/// The floor is applied here, on the way into every DTO. 250 ms is the floor the
/// library tiles already use (`Posters-v1.js`, `Math.max(250, ...)`).
/// </summary>
public static class Timing
{
    public const int MinCycleMs = 250;

    public static int FloorCycle(int cycleMs) => cycleMs < MinCycleMs ? MinCycleMs : cycleMs;
}
