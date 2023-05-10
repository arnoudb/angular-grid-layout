import {
    AfterContentChecked,
    AfterContentInit,
    ChangeDetectionStrategy,
    Component,
    ContentChildren,
    ElementRef,
    EmbeddedViewRef,
    EventEmitter,
    Inject,
    Injector,
    Input,
    NgModuleRef,
    NgZone,
    OnChanges,
    OnDestroy,
    Output,
    QueryList,
    Renderer2,
    SimpleChanges,
    ViewChild,
    ViewContainerRef,
    ViewEncapsulation
} from '@angular/core';
import { coerceNumberProperty, NumberInput } from './coercion/number-property';
import { KtdGridItemComponent } from './grid-item/grid-item.component';
import { combineLatest, fromEvent, merge, NEVER, Observable, Observer, of, Subscription } from 'rxjs';
import { delay, exhaustMap, filter, map, startWith, switchMap, takeUntil, tap, throttleTime } from 'rxjs/operators';
import {
    ktdGetGridItemRowHeight,
    ktdGridItemDragging,
    ktdGridItemLayoutItemAreEqual,
    ktdGridItemResizing
} from './utils/grid.utils';
import { compact } from './utils/react-grid-layout.utils';
import {
    GRID_ITEM_GET_RENDER_DATA_TOKEN,
    KtdGridCfg,
    KtdGridCompactType,
    KtdGridItemRenderData,
    KtdGridLayout,
    KtdGridLayoutItem
} from './grid.definitions';
import { ktdMouseOrTouchEnd, ktdPointerClientX, ktdPointerClientY } from './utils/pointer.utils';
import { KtdDictionary } from '../types';
import { KtdGridService } from './grid.service';
import { getMutableClientRect, KtdClientRect } from './utils/client-rect';
import { ktdGetScrollTotalRelativeDifference$, ktdScrollIfNearElementClientRect$ } from './utils/scroll';
import { BooleanInput, coerceBooleanProperty } from './coercion/boolean-property';
import { KtdGridItemPlaceholder } from './directives/placeholder';

interface KtdDragResizeEvent {
    layout: KtdGridLayout;
    layoutItem: KtdGridLayoutItem;
    gridItemRef: KtdGridItemComponent;
}

interface KtdGridItemDragDropEvent {
    layoutItem: KtdGridLayoutItem;
    gridItemRef: KtdGridItemComponent | null;
    sourceGrid: KtdGridComponent | null;
    newTargetLayout?: KtdGridLayout | null;
}

export type KtdDragStart = KtdDragResizeEvent;
export type KtdResizeStart = KtdDragResizeEvent;
export type KtdDragEnd = KtdDragResizeEvent;
export type KtdResizeEnd = KtdDragResizeEvent;
export type KtdDragEnter = KtdGridItemDragDropEvent;
export type KtdDragExit = KtdGridItemDragDropEvent;
export type KtdDrop = KtdGridItemDragDropEvent;

export interface KtdGridItemResizeEvent {
    width: number;
    height: number;
    gridItemRef: KtdGridItemComponent;
}


type DragActionType = 'drag' | 'resize';

function getDragResizeEventData(gridItem: KtdGridItemComponent, layout: KtdGridLayout): KtdDragResizeEvent {
    return {
        layout,
        layoutItem: layout.find((item) => item.id === gridItem.id)!,
        gridItemRef: gridItem
    };
}

function layoutToRenderItems(config: KtdGridCfg, width: number, height: number): KtdDictionary<KtdGridItemRenderData<number>> {
    const {cols, rowHeight, layout, gap} = config;
    const rowHeightInPixels = rowHeight === 'fit' ? ktdGetGridItemRowHeight(layout, height, gap) : rowHeight;
    const widthExcludingGap = width - Math.max((gap * (cols - 1)), 0);
    const itemWidthPerColumn = (widthExcludingGap / cols);
    const renderItems: KtdDictionary<KtdGridItemRenderData<number>> = {};
    for (const item of layout) {
        renderItems[item.id] = {
            id: item.id,
            top: item.y * rowHeightInPixels + gap * item.y,
            left: item.x * itemWidthPerColumn + gap * item.x,
            width: item.w * itemWidthPerColumn + gap * Math.max(item.w - 1, 0),
            height: item.h * rowHeightInPixels + gap * Math.max(item.h - 1, 0),
        };
    }
    return renderItems;
}

function getGridHeight(layout: KtdGridLayout, rowHeight: number, gap: number): number {
    return layout.reduce((acc, cur) => Math.max(acc, (cur.y + cur.h) * rowHeight + Math.max(cur.y + cur.h - 1, 0) * gap), 0);
}

// eslint-disable-next-line @katoid/prefix-exported-code
export function parseRenderItemToPixels(renderItem: KtdGridItemRenderData<number>): KtdGridItemRenderData<string> {
    return {
        id: renderItem.id,
        top: `${renderItem.top}px`,
        left: `${renderItem.left}px`,
        width: `${renderItem.width}px`,
        height: `${renderItem.height}px`
    };
}

// eslint-disable-next-line @katoid/prefix-exported-code
export function __gridItemGetRenderDataFactoryFunc(gridCmp: KtdGridComponent) {
    return function(id: string) {
        return parseRenderItemToPixels(gridCmp.getItemRenderData(id));
    };
}

export function ktdGridItemGetRenderDataFactoryFunc(gridCmp: KtdGridComponent) {
    // Workaround explained: https://github.com/ng-packagr/ng-packagr/issues/696#issuecomment-387114613
    const resultFunc = __gridItemGetRenderDataFactoryFunc(gridCmp);
    return resultFunc;
}


@Component({
    selector: 'ktd-grid',
    templateUrl: './grid.component.html',
    styleUrls: ['./grid.component.scss'],
    encapsulation: ViewEncapsulation.None,
    changeDetection: ChangeDetectionStrategy.OnPush,
    providers: [
        {
            provide: GRID_ITEM_GET_RENDER_DATA_TOKEN,
            useFactory: ktdGridItemGetRenderDataFactoryFunc,
            deps: [KtdGridComponent]
        }
    ]
})
export class KtdGridComponent implements OnChanges, AfterContentInit, AfterContentChecked, OnDestroy {

    // todo have an instance of draggedItem

    static readonly NEW_LAYOUT_ITEM_ID = 'new_layout_item_id';

    private static draggedLayoutItem: KtdGridLayoutItem | null = null;

    private hasActiveDragSequence = false;
    private static draggedItemTmp: KtdGridItemComponent | null = null;
    private static draggedItem: KtdGridItemComponent | null = null;
    private static draggedItemSourceGrid: KtdGridComponent | null = null;
    private static draggedItemTargetGrid: KtdGridComponent | null = null;

    @ViewChild('tempGridItem', { read: ViewContainerRef }) tempGridItemViewContainerRef: ViewContainerRef;


    /** Query list of grid items that are being rendered. */
    @ContentChildren(KtdGridItemComponent, {descendants: true}) _gridItems: QueryList<KtdGridItemComponent>;

    /** Emits when layout change */
    @Output() layoutUpdated: EventEmitter<KtdGridLayout> = new EventEmitter<KtdGridLayout>();

    /** Emits when drag starts */
    @Output() dragStarted: EventEmitter<KtdDragStart> = new EventEmitter<KtdDragStart>();

    /** Emits when resize starts */
    @Output() resizeStarted: EventEmitter<KtdResizeStart> = new EventEmitter<KtdResizeStart>();

    /** Emits when drag ends */
    @Output() dragEnded: EventEmitter<KtdDragEnd> = new EventEmitter<KtdDragEnd>();

    /** Emits when resize ends */
    @Output() resizeEnded: EventEmitter<KtdResizeEnd> = new EventEmitter<KtdResizeEnd>();

    /** Emits when a grid item is being resized and its bounds have changed */
    @Output() gridItemResize: EventEmitter<KtdGridItemResizeEvent> = new EventEmitter<KtdGridItemResizeEvent>();

    /** drag enter */
    @Output() ktdDragEnter: EventEmitter<KtdDragEnter> = new EventEmitter<KtdDragEnter>();

    /** drag exit */
    @Output() ktdDragExit: EventEmitter<KtdDragExit> = new EventEmitter<KtdDragExit>();

    /** drop */
    @Output() ktdDrop: EventEmitter<KtdDrop> = new EventEmitter<KtdDrop>();

    /** other grids that can drop items on this grid */
    @Input() connectedTo: KtdGridComponent[] = [];

    /**
     * Parent element that contains the scroll. If an string is provided it would search that element by id on the dom.
     * If no data provided or null autoscroll is not performed.
     */
    @Input() scrollableParent: HTMLElement | Document | string | null = null;

    /** Whether or not to update the internal layout when some dependent property change. */
    @Input()
    get compactOnPropsChange(): boolean { return this._compactOnPropsChange; }

    set compactOnPropsChange(value: boolean) {
        this._compactOnPropsChange = coerceBooleanProperty(value);
    }

    private _compactOnPropsChange: boolean = true;

    /** If true, grid items won't change position when being dragged over. Handy when using no compaction */
    @Input()
    get preventCollision(): boolean { return this._preventCollision; }

    set preventCollision(value: boolean) {
        this._preventCollision = coerceBooleanProperty(value);
    }

    private _preventCollision: boolean = false;

    /** Number of CSS pixels that would be scrolled on each 'tick' when auto scroll is performed. */
    @Input()
    get scrollSpeed(): number { return this._scrollSpeed; }

    set scrollSpeed(value: number) {
        this._scrollSpeed = coerceNumberProperty(value, 2);
    }

    private _scrollSpeed: number = 2;

    /** Type of compaction that will be applied to the layout (vertical, horizontal or free). Defaults to 'vertical' */
    @Input()
    get compactType(): KtdGridCompactType {
        return this._compactType;
    }

    set compactType(val: KtdGridCompactType) {
        this._compactType = val;
    }

    private _compactType: KtdGridCompactType = 'vertical';

    /**
     * Row height as number or as 'fit'.
     * If rowHeight is a number value, it means that each row would have those css pixels in height.
     * if rowHeight is 'fit', it means that rows will fit in the height available. If 'fit' value is set, a 'height' should be also provided.
     */
    @Input()
    get rowHeight(): number | 'fit' { return this._rowHeight; }

    set rowHeight(val: number | 'fit') {
        this._rowHeight = val === 'fit' ? val : Math.max(1, Math.round(coerceNumberProperty(val)));
    }

    private _rowHeight: number | 'fit' = 100;

    /** Number of columns  */
    @Input()
    get cols(): number { return this._cols; }

    set cols(val: number) {
        this._cols = Math.max(1, Math.round(coerceNumberProperty(val)));
    }

    private _cols: number = 6;

    /** Layout of the grid. Array of all the grid items with its 'id' and position on the grid. */
    @Input()
    get layout(): KtdGridLayout {
        return this._layout;
    }

    set layout(layout: KtdGridLayout) {
        /**
         * Enhancement:
         * Only set layout if it's reference has changed and use a boolean to track whenever recalculate the layout on ngOnChanges.
         *
         * Why:
         * The normal use of this lib is having the variable layout in the outer component or in a store, assigning it whenever it changes and
         * binded in the component with it's input [layout]. In this scenario, we would always calculate one unnecessary change on the layout when
         * it is re-binded on the input.
         */
        this._layout = layout;
    }

    private _layout: KtdGridLayout;

    /** Grid gap in css pixels */
    @Input()
    get gap(): number {
        return this._gap;
    }

    set gap(val: number) {
        this._gap = Math.max(coerceNumberProperty(val), 0);
    }

    private _gap: number = 0;


    /**
     * If height is a number, fixes the height of the grid to it, recommended when rowHeight = 'fit' is used.
     * If height is null, height will be automatically set according to its inner grid items.
     * Defaults to null.
     * */
    @Input()
    get height(): number | null {
        return this._height;
    }

    set height(val: number | null) {
        this._height = typeof val === 'number' ? Math.max(val, 0) : null;
    }

    private _height: number | null = null;
    private gridCurrentHeight: number;

    get config(): KtdGridCfg {
        return {
            cols: this.cols,
            rowHeight: this.rowHeight,
            height: this.height,
            layout: this.layout,
            preventCollision: this.preventCollision,
            gap: this.gap,
        };
    }

    /** Reference to the view of the placeholder element. */
    private placeholderRef: EmbeddedViewRef<any> | null;

    /** Element that is rendered as placeholder when a grid item is being dragged */
    private placeholder: HTMLElement | null;

    protected _gridItemsRenderData: KtdDictionary<KtdGridItemRenderData<number>>;
    private subscriptions: Subscription[];

    constructor(private gridService: KtdGridService,
                private elementRef: ElementRef,
                private viewContainerRef: ViewContainerRef,
                private renderer: Renderer2,
                private ngZone: NgZone,
                @Inject(NgModuleRef) private moduleRef: NgModuleRef<any>,
                private injector:Injector) {
    }

    ngOnChanges(changes: SimpleChanges) {

        if (this.rowHeight === 'fit' && this.height == null) {
            console.warn(`KtdGridComponent: The @Input() height should not be null when using rowHeight 'fit'`);
        }

        let needsCompactLayout = false;
        let needsRecalculateRenderData = false;

        // TODO: Does fist change need to be compacted by default?
        // Compact layout whenever some dependent prop changes.
        if (changes.compactType || changes.cols || changes.layout) {
            needsCompactLayout = true;
        }

        // Check if wee need to recalculate rendering data.
        if (needsCompactLayout || changes.rowHeight || changes.height || changes.gap) {
            needsRecalculateRenderData = true;
        }

        // Only compact layout if lib user has provided it. Lib users that want to save/store always the same layout  as it is represented (compacted)
        // can use KtdCompactGrid utility and pre-compact the layout. This is the recommended behaviour for always having a the same layout on this component
        // and the ones that uses it.
        if (needsCompactLayout && this.compactOnPropsChange) {
            this.compactLayout();
        }

        if (needsRecalculateRenderData) {
            this.calculateRenderData();
        }
    }

    ngAfterContentInit() {
        this.initSubscriptions();
    }

    ngAfterContentChecked() {
        this.render();
    }

    resize() {
        this.calculateRenderData();
        this.render();
    }

    ngOnDestroy() {
        this.subscriptions.forEach(sub => sub.unsubscribe());
    }

    compactLayout() {
        this.layout = compact(this.layout, this.compactType, this.cols);
    }

    getItemsRenderData(): KtdDictionary<KtdGridItemRenderData<number>> {
        return {...this._gridItemsRenderData};
    }

    getItemRenderData(itemId: string): KtdGridItemRenderData<number> {
        return this._gridItemsRenderData[itemId];
    }

    calculateRenderData() {
        const clientRect = (this.elementRef.nativeElement as HTMLElement).getBoundingClientRect();
        this.gridCurrentHeight = this.height ?? (this.rowHeight === 'fit' ? clientRect.height : getGridHeight(this.layout, this.rowHeight, this.gap));
        this._gridItemsRenderData = layoutToRenderItems(this.config, clientRect.width, this.gridCurrentHeight);
    }

    render() {
        this.renderer.setStyle(this.elementRef.nativeElement, 'height', `${this.gridCurrentHeight}px`);
        this.updateGridItemsStyles();
    }

    private updateGridItemsStyles() {

        this._gridItems.forEach(item => {
            const gridItemRenderData: KtdGridItemRenderData<number> | undefined = this._gridItemsRenderData[item.id];
            if (gridItemRenderData == null) {
                console.error(`Couldn\'t find the specified grid item for the id: ${item.id}`);
            } else if (gridItemRenderData) {
                item.setStyles(parseRenderItemToPixels(gridItemRenderData));
            }
        });

        const item = KtdGridComponent.draggedItemTmp;
        //console.log('XXX', item, item?.id, item && this._gridItemsRenderData[item.id])
        if (item && this._gridItemsRenderData[item.id] && item.id === KtdGridComponent.NEW_LAYOUT_ITEM_ID) {
            console.log('WHY!?!?!?!?', this._gridItemsRenderData[item.id]);
            item.setStyles(parseRenderItemToPixels(this._gridItemsRenderData[item.id]));
        }
    }

    private initSubscriptions() {

        const nativeElement = this.elementRef.nativeElement;
        const pointerDown$ = fromEvent(nativeElement, 'pointerdown');
        const pointerMove$ = fromEvent(nativeElement, 'pointermove');
        const pointerUp$ = fromEvent(nativeElement, 'pointerup');
        const pointerEnter$ = fromEvent(nativeElement, 'pointerenter');

        this.subscriptions = [

            // this._gridItems.changes.subscribe((x) => {
            //     //console.log(this.elementRef.nativeElement.id, x);
            // }),

            // fromEvent(nativeElement, 'pointerdown').subscribe((event:PointerEvent) => {
            //     KtdGridComponent.draggedItemSourceGrid = this;
            // }),

            fromEvent(nativeElement, 'pointerenter').subscribe((event:PointerEvent) => {

                console.log('pointerenter!');
                if (KtdGridComponent.draggedItemSourceGrid === null) {
                    return;
                }

                KtdGridComponent.draggedItemTargetGrid = this;

                // prevent multiple subscriptions
                if (this.hasActiveDragSequence) {
                    return;
                }

                if (KtdGridComponent.draggedItem !== null
                    && KtdGridComponent.draggedItemTargetGrid !== KtdGridComponent.draggedItemSourceGrid
                    && KtdGridComponent.draggedItemSourceGrid) {

                    const sourceLayout = KtdGridComponent.draggedItemSourceGrid.layout;
                    const layoutItemToMove = sourceLayout.find(i => i.id === KtdGridComponent.draggedItem!.id);

                    if (layoutItemToMove) {
                        const newLayoutItem = {...layoutItemToMove, id: KtdGridComponent.NEW_LAYOUT_ITEM_ID};

                        // todo not good, as the position is not correct
                        const dragEnter:KtdDragEnter = {
                            layoutItem: newLayoutItem,
                            gridItemRef: KtdGridComponent.draggedItem, // todo
                            sourceGrid: KtdGridComponent.draggedItemSourceGrid
                        }
                        this.ktdDragEnter.emit(dragEnter);

                       // create a dynamic component
                        const gridItemComponent = this.tempGridItemViewContainerRef.createComponent(KtdGridItemComponent, {ngModuleRef: this.moduleRef, injector: this.injector});
                        gridItemComponent.instance.id = newLayoutItem.id;
                        KtdGridComponent.draggedItemTmp = gridItemComponent.instance;



                        gridItemComponent.instance.elementRef.nativeElement.style.display = 'block';
                        gridItemComponent.instance.elementRef.nativeElement.style.width = '50px';
                        gridItemComponent.instance.elementRef.nativeElement.style.height = '50px';
                        gridItemComponent.instance.elementRef.nativeElement.style.background = 'green';

                        this.renderer.addClass( gridItemComponent.instance.elementRef.nativeElement, 'no-transitions');
                        this.renderer.addClass( gridItemComponent.instance.elementRef.nativeElement, 'ktd-grid-item-dragging');

                        this.hasActiveDragSequence = true;

                        return this.performDragSequence$(<KtdGridItemComponent>gridItemComponent.instance, event, 'drag').subscribe((x) => {
                                console.log('secundary value!!!', x);
                                const item = x.find(y => y.id === KtdGridComponent.NEW_LAYOUT_ITEM_ID);
                                if (item) {
                                    item.id = layoutItemToMove.id;
                                }
                                const dragDrop:KtdDrop = {
                                    sourceGrid: KtdGridComponent.draggedItemSourceGrid,
                                    gridItemRef: KtdGridComponent.draggedItem,
                                    layoutItem: KtdGridComponent.draggedItemSourceGrid!.layout.find(i => i.id === KtdGridComponent.draggedItem?.id)!,
                                    newTargetLayout: x,
                                }
                                this.ktdDrop.emit(dragDrop);
                            },
                            null,
                            () => {
                                console.log('secundary complete!!!');
                                this.hasActiveDragSequence = false;
                                KtdGridComponent.draggedItemSourceGrid = null;
                            }
                        );
                    }
                }
            }),

            fromEvent(nativeElement, 'pointerleave').pipe(delay(0)).subscribe((event:PointerEvent) => {
                //console.log('pointerleave');
                // this restores the animation back to original
                //if (KtdGridComponent.draggedItemTargetGrid === this && KtdGridComponent.draggedItemTargetGrid !== KtdGridComponent.draggedItemSourceGrid) {
                    KtdGridComponent.draggedItemTargetGrid = KtdGridComponent.draggedItemSourceGrid;
                    // todo delete it from the grid, its not in the layout, but exists in the view
                    KtdGridComponent.draggedItemTmp = null;
                    this.tempGridItemViewContainerRef.clear();
                //}
            }),

            // fromEvent(nativeElement, 'pointerup').pipe(delay(0)).subscribe((event:PointerEvent) => {
            //
            //     // better here saver...
            //     this.hasActiveDragSequence = false;
            //
            //    // console.log()
            //     if (KtdGridComponent.draggedItemSourceGrid !== KtdGridComponent.draggedItemTargetGrid && KtdGridComponent.draggedItemSourceGrid !== null && KtdGridComponent.draggedItemTargetGrid === this) {
            //        // console.log('pointerup in target grid');
            //        //  const dragDrop:KtdDrop = {
            //        //      sourceGrid: KtdGridComponent.draggedItemSourceGrid,
            //        //      gridItemRef: KtdGridComponent.draggedItem,
            //        //      layoutItem: KtdGridComponent.draggedItemSourceGrid.layout.find(i => i.id === KtdGridComponent.draggedItem?.id)!,
            //        //  }
            //        //  this.ktdDrop.emit(dragDrop);
            //
            //         // ?
            //         // KtdGridComponent.draggedItemSourceGrid.placeholder?.remove();
            //
            //         // nope, animate
            //         //document.getElementById('ktd-drag-proxy-element')?.remove();
            //     }
            //
            //     KtdGridComponent.draggedItemSourceGrid = null;
            // }),


            this._gridItems.changes.pipe(
                startWith(this._gridItems),
                switchMap((gridItems: QueryList<KtdGridItemComponent>) => {
                    // convert the array of grid items to collection of dragStart and resizeStart observables
                    return merge(
                        ...gridItems.map((gridItem) => gridItem.dragStart$.pipe(map((event) => ({event, gridItem, type: 'drag' as DragActionType})))),
                        ...gridItems.map((gridItem) => gridItem.resizeStart$.pipe(map((event) => ({event, gridItem, type: 'resize' as DragActionType})))),
                    ).pipe(
                        // by running exhaustmap we make sure that we keep going?
                        // why this nested pipe?

                        // not sure why we need this.
                        exhaustMap(({event, gridItem, type}) => {
                        // Emit drag or resize start events. Ensure that is start event is inside the zone.
                        this.ngZone.run(() => (type === 'drag' ? this.dragStarted : this.resizeStarted).emit(getDragResizeEventData(gridItem, this.layout)));


                        console.log('dragstart')

                        // initialize cross dragging state
                        KtdGridComponent.draggedItem = gridItem;
                        KtdGridComponent.draggedItemSourceGrid = this;
                        KtdGridComponent.draggedItemTargetGrid = this;

                        // Perform drag sequence
                        // do we need those nested pipes?
                        return this.performDragSequence$(gridItem, event, type).pipe(
                            //takeWhile(() =>  KtdGridComponent.draggedItemSourceGrid === KtdGridComponent.draggedItemTargetGrid && KtdGridComponent.draggedItemSourceGrid === this),
                            tap(x => {console.log('?????? source drag sequence', x)}),
                            map((layout) => ({layout, gridItem, type})));

                    }));
                })
            ).subscribe(({layout, gridItem, type}) => {
                this.layout = layout;
                // Calculate new rendering data given the new layout.
                this.calculateRenderData();
                // Emit drag or resize end events.
                (type === 'drag' ? this.dragEnded : this.resizeEnded).emit(getDragResizeEventData(gridItem, layout));
                // Notify that the layout has been updated.
                this.layoutUpdated.emit(layout);

                console.log('main dragend')

                // KtdGridComponent.draggedItem = null;
                // KtdGridComponent.draggedItemSourceGrid = null;
                // KtdGridComponent.draggedItemTargetGrid = null;
            })
        ];
    }

    /**
     * Perform a general grid drag action, from start to end. A general grid drag action basically includes creating the placeholder element and adding
     * some class animations.
     * @param gridItem that is being dragged
     * @param pointerDownEvent event (mousedown or touchdown) where the user initiated the drag
     * @param type the type of drag sequence that is executed (`drag` or `resize`)
     */
    private performDragSequence$(gridItem: KtdGridItemComponent, pointerDownEvent: MouseEvent | TouchEvent, type: DragActionType): Observable<KtdGridLayout> {

        this.hasActiveDragSequence = true;

        return new Observable<KtdGridLayout>((observer: Observer<KtdGridLayout>) => {
            // Retrieve grid (parent) and gridItem (draggedElem) client rects.
            const gridElemClientRect: KtdClientRect = getMutableClientRect(this.elementRef.nativeElement as HTMLElement);
            const dragElemClientRect: KtdClientRect = getMutableClientRect(gridItem.elementRef.nativeElement as HTMLElement);

            //console.log('dragElemClientRect', dragElemClientRect);
            const scrollableParent = typeof this.scrollableParent === 'string' ? document.getElementById(this.scrollableParent) as HTMLElement : this.scrollableParent as HTMLElement;


            // Create a dragproxy
            // We clone the dragged item and move it out of the grid to be able to drag it outside the grid boundaries.
            // This also makes sure it's always on top of any other element.
            // Here we also correct the global position it stays visually exactly on the same location.

            // document.getElementById('ktd-drag-proxy-element')?.remove();
            // keep using the exising one!
            if (document.getElementById('ktd-drag-proxy-element') === null && type === 'drag') {


                // const dragProxy = document.createElement('div');
                // dragProxy.classList.add('ktd-grid-item')
                // const child = <HTMLElement>gridItem.elementRef.nativeElement.querySelector('.grid-item-content')?.cloneNode(true);
                // dragProxy.appendChild(child);
                // dragProxy.setAttribute('style', gridItem.elementRef.nativeElement.getAttribute('style'));

                const dragProxy = gridItem.elementRef.nativeElement.cloneNode(true);
                dragProxy.id = 'ktd-drag-proxy-element';
                dragProxy.draggable = true;
                dragProxy.style.position = 'absolute';
                dragProxy.style.zIndex = '1000';
                dragProxy.style.pointerEvents = 'none';
                document.body.appendChild(dragProxy);

                // replaced by absolute position for drag proxy while dragging.
                // if we stop dragging we apply the same transform as the dragged item. This results in the proxy
                // animating exactly to the desired position.
                dragProxy.style.transform = '';
                dragProxy.style.opacity = 0.5;

                // set initial absolute position based on the gridItem corected by the grid position and the scroll position
                const itemRenderData = this.getItemRenderData(gridItem.id);
                dragProxy.style.top = (gridElemClientRect.top + itemRenderData.top + window.scrollY) + 'px';
                dragProxy.style.left = (gridElemClientRect.left + itemRenderData.left + window.scrollX) + 'px';

                // maybe not needed, but it's the optimized start position.
                const deltaX = (<MouseEvent>pointerDownEvent).clientX - gridElemClientRect.left - itemRenderData.left;
                const deltaY = (<MouseEvent>pointerDownEvent).clientY - gridElemClientRect.top - itemRenderData.top;

                // update the position of the proxy based on the mouse position (we shoudl make this more generic for pointer events)
                const update = (event: MouseEvent) => {
                    dragProxy.style.left = (event.clientX + window.scrollX - deltaX) + 'px';
                    dragProxy.style.top = (event.clientY + window.scrollY - deltaY) + 'px';
                }

                // todo make observable something like:
                fromEvent(window,'pointermove').pipe(
                    takeUntil(fromEvent(window, 'pointerup'))
                ).subscribe(
                    {
                        next: (event: MouseEvent) => {
                            dragProxy.style.left = (event.clientX + window.scrollX - deltaX) + 'px';
                            dragProxy.style.top = (event.clientY + window.scrollY - deltaY) + 'px';
                        },
                        complete: () => {
                            this.renderer.removeClass(dragProxy, 'no-transitions');

                            // animate to origin
                            if (KtdGridComponent.draggedItemTargetGrid === KtdGridComponent.draggedItemSourceGrid) {


                                const grid = (KtdGridComponent.draggedItemTargetGrid === KtdGridComponent.draggedItemSourceGrid) ? this : KtdGridComponent.draggedItemTargetGrid;
                                if (!grid) {
                                   throw new Error('not good');
                                }

                                const id = KtdGridComponent.draggedItemTmp ? KtdGridComponent.draggedItemTmp.id : gridItem.id;
                                const newGridItemRenderData = {...grid._gridItemsRenderData[id]};


                                console.log('##########', newGridItemRenderData, this.elementRef.nativeElement.getBoundingClientRect())

                                newGridItemRenderData.left = newGridItemRenderData.left
                                    + grid.elementRef.nativeElement.getBoundingClientRect().left
                                    - dragProxy.getBoundingClientRect().left;

                                newGridItemRenderData.top = newGridItemRenderData.top
                                    + grid.elementRef.nativeElement.getBoundingClientRect().top
                                    - dragProxy.getBoundingClientRect().top;

                                // todo this is not nice and not an observable
                                // alo what if we dont have a transition?
                                const transitionEndHandler = (event:Event) => {
                                    gridItem.elementRef.nativeElement.removeEventListener('transitionend', transitionEndHandler);
                                    const dragProxyElement = <HTMLElement>document.getElementById('ktd-drag-proxy-element');
                                    dragProxyElement.remove();
                                    gridItem.elementRef.nativeElement.style.opacity = 1;
                                };

                                dragProxy.addEventListener('transitionend', transitionEndHandler);

                                // set proxy goal position
                                const positionStyles = parseRenderItemToPixels(newGridItemRenderData);
                                dragProxy.style.transform = `translateX(${positionStyles.left}) translateY(${positionStyles.top})`;
                            } else {
                                console.log('animate proxy to target grid');
                                KtdGridComponent.draggedItemTmp = null
                                this.tempGridItemViewContainerRef.clear();
                                dragProxy.remove();
                            }
                        }
                    });

                gridItem.elementRef.nativeElement.style.opacity = 0.25;
            } else {
                console.log('dragproxy already there or we resize: ${type}');
            }

            this.renderer.addClass(gridItem.elementRef.nativeElement, 'no-transitions');
            this.renderer.addClass(gridItem.elementRef.nativeElement, 'ktd-grid-item-dragging');

            // is dit wel ok ??

            const dragElemClientRect2 = document.getElementById('ktd-drag-proxy-element')?.getBoundingClientRect();

            const placeholderClientRect: KtdClientRect = {
                ...dragElemClientRect,
                left: dragElemClientRect.left - gridElemClientRect.left,
                top: dragElemClientRect.top - gridElemClientRect.top
            }
            this.createPlaceholderElement(placeholderClientRect, gridItem.placeholder);

            console.log(1, placeholderClientRect);
            let newLayout: KtdGridLayoutItem[];

            // TODO (enhancement): consider move this 'side effect' observable inside the main drag loop.
            //  - Pros are that we would not repeat subscriptions and takeUntil would shut down observables at the same time.
            //  - Cons are that moving this functionality as a side effect inside the main drag loop would be confusing.
            const scrollSubscription = this.ngZone.runOutsideAngular(() =>
                (!scrollableParent ? NEVER : this.gridService.mouseOrTouchMove$(document).pipe(
                    map((event) => ({
                        pointerX: ktdPointerClientX(event),
                        pointerY: ktdPointerClientY(event)
                    })),
                    ktdScrollIfNearElementClientRect$(scrollableParent, {scrollStep: this.scrollSpeed})
                )).pipe(
                    takeUntil(ktdMouseOrTouchEnd(document))
                ).subscribe());

            /**
             * Main subscription, it listens for 'pointer move' and 'scroll' events and recalculates the layout on each emission
             */
            const subscription = this.ngZone.runOutsideAngular(() =>
                merge(
                    combineLatest([
                        this.gridService.mouseOrTouchMove$(document),
                        ...(!scrollableParent ? [of({top: 0, left: 0})] : [
                            ktdGetScrollTotalRelativeDifference$(scrollableParent).pipe(
                                startWith({top: 0, left: 0}) // Force first emission to allow CombineLatest to emit even no scroll event has occurred
                            )
                        ])
                    ])
                ).pipe(
                    takeUntil(ktdMouseOrTouchEnd(document)),
                    throttleTime(20),
                    filter(() => KtdGridComponent.draggedItemTargetGrid === this),
                ).subscribe(([pointerDragEvent, scrollDifference]: [MouseEvent | TouchEvent, { top: number, left: number }]) => {
                        pointerDragEvent.preventDefault();


                        // if (KtdGridComponent.draggedItemSourceGrid !== KtdGridComponent.draggedItemTargetGrid) {
                        //     return;
                        // }

                        console.log(2);
                        /**
                         * Set the new layout to be the layout in which the calcNewStateFunc would be executed.
                         * NOTE: using the mutated layout is the way to go by 'react-grid-layout' utils. If we don't use the previous layout,
                         * some utilities from 'react-grid-layout' would not work as expected.
                         */

                        // todo arnoud, maybe add item here ?
                        const currentLayout: KtdGridLayout = newLayout || this.layout;

                        if (gridItem.id === KtdGridComponent.NEW_LAYOUT_ITEM_ID && !currentLayout.find(i => i.id === KtdGridComponent.NEW_LAYOUT_ITEM_ID)) {
                            const item = {id: KtdGridComponent.NEW_LAYOUT_ITEM_ID, w: 2, h: 2, x:5, y: 5};
                            currentLayout.push(item)
                            console.log('we just added the new layout item!', item);
                            //debugger;
                        }

                        //console.log(newLayout, this.layout)
                        //console.log(this.elementRef.nativeElement.id);

                        // Get the correct newStateFunc depending on if we are dragging or resizing
                        const calcNewStateFunc = type === 'drag' ? ktdGridItemDragging : ktdGridItemResizing;

                        console.log('gridElemClientRect', this.elementRef.nativeElement.id, gridElemClientRect)

                        const {layout, draggedItemPos} = calcNewStateFunc(gridItem, {
                            layout: currentLayout,
                            rowHeight: this.rowHeight,
                            height: this.height,
                            cols: this.cols,
                            preventCollision: this.preventCollision,
                            gap: this.gap,
                        }, this.compactType, {
                            pointerDownEvent,
                            pointerDragEvent,
                            gridElemClientRect: KtdGridComponent.draggedItemTargetGrid ? KtdGridComponent.draggedItemTargetGrid.elementRef.nativeElement.getBoundingClientRect() : gridElemClientRect,
                            dragElemClientRect: type === 'drag' && dragElemClientRect2 || dragElemClientRect,
                            scrollDifference
                        });
                        newLayout = layout;

                        if (newLayout.find(i => i.id === KtdGridComponent.NEW_LAYOUT_ITEM_ID)) {
                            console.log('draggedItemPos', newLayout.find(i => i.id === KtdGridComponent.NEW_LAYOUT_ITEM_ID), draggedItemPos);
                            //debugger;


                        }

                        this.gridCurrentHeight = this.height ?? (this.rowHeight === 'fit' ? gridElemClientRect.height : getGridHeight(newLayout, this.rowHeight, this.gap))

                        this._gridItemsRenderData = layoutToRenderItems({
                            cols: this.cols,
                            rowHeight: this.rowHeight,
                            height: this.height,
                            layout: newLayout,
                            preventCollision: this.preventCollision,
                            gap: this.gap,
                        }, gridElemClientRect.width, gridElemClientRect.height);


                        const newGridItemRenderData = {...this._gridItemsRenderData[gridItem.id]}
                        const placeholderStyles = parseRenderItemToPixels(newGridItemRenderData);
                        console.log('newGridItemRenderData', newGridItemRenderData);

                        // Put the real final position to the placeholder element
                        this.placeholder!.style.width = placeholderStyles.width;
                        this.placeholder!.style.height = placeholderStyles.height;
                        this.placeholder!.style.transform = `translateX(${placeholderStyles.left}) translateY(${placeholderStyles.top})`;

                        //console.log( this.placeholder!.style);

                        //this.placeholder!.scrollIntoView({behavior: 'smooth'});

                        const proxy = (<HTMLElement>document.getElementById('ktd-drag-proxy-element'))?.getBoundingClientRect() ?? {left:0, right: 0};
                        const grid = (KtdGridComponent.draggedItemTargetGrid === KtdGridComponent.draggedItemSourceGrid) ? this : KtdGridComponent.draggedItemTargetGrid;
                        if (!grid) {
                            throw new Error('not good');
                        }
                        const rect = this.elementRef.nativeElement.getBoundingClientRect();
                        let left = proxy.left - rect.left + (<HTMLElement>this.scrollableParent)?.scrollLeft ?? 0;
                        let top = proxy.top - rect.top + (<HTMLElement>this.scrollableParent)?.scrollTop ?? 0;

                        //const width = KtdGridComponent.draggedItem.elementRef.nativeElement.offsetWidth;
                        //const height = KtdGridComponent.draggedItem.elementRef.nativeElement.offsetWidth;
                        //const id = KtdGridComponent.draggedItem.id;
                        //item.setStyles(parseRenderItemToPixels({left, top, height, width, id}))

                        if (KtdGridComponent.draggedItem === gridItem) {
                            left = draggedItemPos.left;
                            top = draggedItemPos.top;
                        } else if (KtdGridComponent.draggedItemTmp) {
                            //console.log('left-top', left, top)
                        }


                        // modify the position of the dragged item to be the one we want (for example the mouse position or whatever)
                        this._gridItemsRenderData[gridItem.id] = {
                            ...draggedItemPos,
                            left,
                            top,
                            id: this._gridItemsRenderData[gridItem.id].id
                        };

                        this.render();

                        // If we are performing a resize, and bounds have changed, emit event.
                        // NOTE: Only emit on resize for now. Use case for normal drag is not justified for now. Emitting on resize is, since we may want to re-render the grid item or the placeholder in order to fit the new bounds.
                        if (type === 'resize') {
                            const prevGridItem = currentLayout.find(item => item.id === gridItem.id)!;
                            const newGridItem = newLayout.find(item => item.id === gridItem.id)!;
                            // Check if item resized has changed, if so, emit resize change event
                            if (!ktdGridItemLayoutItemAreEqual(prevGridItem, newGridItem)) {
                                this.gridItemResize.emit({
                                    width: newGridItemRenderData.width,
                                    height: newGridItemRenderData.height,
                                    gridItemRef: getDragResizeEventData(gridItem, newLayout).gridItemRef
                                });
                            }
                        }
                    },
                    (error) => observer.error(error),
                    () => {
                        this.ngZone.run(() => {
                            // Remove drag classes
                            this.renderer.removeClass(gridItem.elementRef.nativeElement, 'no-transitions');
                            this.renderer.removeClass(gridItem.elementRef.nativeElement, 'ktd-grid-item-dragging');

                            this.destroyPlaceholder();

                            if (newLayout) {
                                // TODO: newLayout should already be pruned. If not, it should have type Layout, not KtdGridLayout as it is now.
                                // Prune react-grid-layout compact extra properties.
                                observer.next(newLayout.map(item => ({
                                    id: item.id,
                                    x: item.x,
                                    y: item.y,
                                    w: item.w,
                                    h: item.h,
                                    minW: item.minW,
                                    minH: item.minH,
                                    maxW: item.maxW,
                                    maxH: item.maxH,
                                })) as KtdGridLayout);
                            } else {
                                // TODO: Need we really to emit if there is no layout change but drag started and ended?
                                //observer.next(this.layout);
                            }
                            this.hasActiveDragSequence = false;
                            observer.complete();
                        });

                    }));


            return () => {
                scrollSubscription.unsubscribe();
                subscription.unsubscribe();
            };
        });
    }

    /** Creates placeholder element */
    private createPlaceholderElement(clientRect: KtdClientRect, gridItemPlaceholder?: KtdGridItemPlaceholder) {
        if (this.placeholder) {
            this.placeholder.remove();
        }
        this.placeholder = this.renderer.createElement('div');
        this.placeholder!.style.width = `${clientRect.width}px`;
        this.placeholder!.style.height = `${clientRect.height}px`;
        this.placeholder!.style.transform = `translateX(${clientRect.left}px) translateY(${clientRect.top}px)`;
        this.placeholder!.classList.add('ktd-grid-item-placeholder');
        this.renderer.appendChild(this.elementRef.nativeElement, this.placeholder);

        //console.log(this.placeholder);

        // Create and append custom placeholder if provided.
        // Important: Append it after creating & appending the container placeholder. This way we ensure parent bounds are set when creating the embeddedView.
        if (gridItemPlaceholder) {
            this.placeholderRef = this.viewContainerRef.createEmbeddedView(
                gridItemPlaceholder.templateRef,
                gridItemPlaceholder.data
            );
            this.placeholderRef.rootNodes.forEach(node => this.placeholder!.appendChild(node));
            this.placeholderRef.detectChanges();
        } else {
            this.placeholder!.classList.add('ktd-grid-item-placeholder-default');
        }
    }

    /** Destroys the placeholder element and its ViewRef. */
    private destroyPlaceholder() {
        this.placeholder?.remove();
        this.placeholderRef?.destroy();
        this.placeholder = this.placeholderRef = null!;
    }

    static ngAcceptInputType_cols: NumberInput;
    static ngAcceptInputType_rowHeight: NumberInput;
    static ngAcceptInputType_scrollSpeed: NumberInput;
    static ngAcceptInputType_compactOnPropsChange: BooleanInput;
    static ngAcceptInputType_preventCollision: BooleanInput;
}

